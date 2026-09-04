'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import RegionTimeline from './RegionTimeline';
import { getConfigContentId, parseRegionConfig } from '../lib/region-config';
import type { CaseDefinition, RegionInstance } from '../lib/region-config';

const MAX_RENDER_POINTS = 500_000;

type CloudStats = {
  sourcePoints: number;
  renderedPoints: number;
  duration: number;
  fileName: string;
};

type ViewerApi = {
  loadBuffer: (buffer: ArrayBuffer, fileName: string) => Promise<void>;
  setPointSize: (size: number) => void;
  setTimeScale: (scale: number) => void;
  setAutoRotate: (enabled: boolean) => void;
  setRegions: (cases: CaseDefinition[], instances: RegionInstance[]) => void;
  centerPivot: () => void;
  resetCamera: () => void;
};

type Progress = { label: string; value: number };

type ParsedCloud = {
  positions: ArrayBuffer;
  colors: ArrayBuffer;
  sourcePoints: number;
  renderedPoints: number;
  minTime: number;
  maxTime: number;
};

function parsePointCloud(buffer: ArrayBuffer, onProgress: (value: number) => void) {
  return new Promise<ParsedCloud>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/ply-parser.worker.ts', import.meta.url));
    worker.onmessage = (event: MessageEvent<ParsedCloud & { type: string; value?: number; message?: string }>) => {
      if (event.data.type === 'progress') {
        onProgress(event.data.value ?? 0);
      } else if (event.data.type === 'complete') {
        worker.terminate();
        resolve(event.data);
      } else if (event.data.type === 'error') {
        worker.terminate();
        reject(new Error(event.data.message ?? 'PLY 解析失败'));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || '点云解析线程发生错误'));
    };
    worker.postMessage({ buffer, maxPoints: MAX_RENDER_POINTS }, [buffer]);
  });
}

function readLocalFile(file: File, onProgress: (value: number) => void) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取本地文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

async function readResponse(response: Response, onProgress: (value: number) => void) {
  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total) onProgress(received / total);
  }

  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

const formatPoints = (value: number) =>
  new Intl.NumberFormat('zh-CN', { notation: value >= 1000000 ? 'compact' : 'standard' }).format(value);

export default function PointCloudViewer() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const regionFileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<ViewerApi | null>(null);
  const statsRef = useRef<CloudStats | null>(null);
  const pointSizeRef = useRef(2);
  const timeScaleRef = useRef(0.1);
  const initialRegionsRef = useRef(true);
  const [stats, setStats] = useState<CloudStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [pointSize, setPointSize] = useState(2);
  const [timeScale, setTimeScale] = useState(0.1);
  const [autoRotate, setAutoRotate] = useState(false);
  const [progress, setProgress] = useState<Progress>({ label: '准备读取', value: 0 });
  const [caseDefinitions, setCaseDefinitions] = useState<CaseDefinition[]>([]);
  const [regionInstances, setRegionInstances] = useState<RegionInstance[]>([]);
  const [regionError, setRegionError] = useState('');
  const [configLabel, setConfigLabel] = useState('项目默认配置');

  const timelineDuration = Math.max(
    stats?.duration ?? 0,
    ...regionInstances.map((instance) => instance.end),
    1
  );

  const applyRegionConfig = useCallback((casesXml: string, fieldsXml: string, label: string) => {
    const definitions = parseRegionConfig(casesXml, fieldsXml);
    if (definitions.length === 0) throw new Error('Case Table 中没有 Monitoring Case');
    const missing = Array.from(new Set(definitions.flatMap((definition) => definition.missingFields)));
    if (missing.length > 0) {
      throw new Error(`配置不匹配，找不到区域：${missing.join('、')}`);
    }
    const initialDuration = Math.max(statsRef.current?.duration ?? 10, 1);
    setCaseDefinitions(definitions);
    setRegionInstances(definitions.map((definition) => ({
      id: `${definition.id}-${Date.now()}`,
      caseId: definition.id,
      start: 0,
      end: initialDuration,
      visible: true,
    })));
    setConfigLabel(label);
    setRegionError('');
    initialRegionsRef.current = !statsRef.current;
  }, []);

  const loadRegionFiles = useCallback(async (files: FileList | File[]) => {
    setRegionError('');
    try {
      let casesXml = '';
      let fieldsXml = '';
      let casesName = '';
      let fieldsName = '';
      for (const file of Array.from(files)) {
        const source = await file.text();
        const contentId = getConfigContentId(source);
        if (contentId === 'Scanner CaseTable Export') {
          casesXml = source;
          casesName = file.name;
        } else if (contentId === 'Scanner Field Export') {
          fieldsXml = source;
          fieldsName = file.name;
        }
      }
      if (!casesXml || !fieldsXml) {
        throw new Error('请同时选择该设备的 Case Table 和 Field Export 两个 XML 文件');
      }
      applyRegionConfig(casesXml, fieldsXml, `${casesName} + ${fieldsName}`);
    } catch (cause) {
      setRegionError(cause instanceof Error ? cause.message : '设备配置读取失败');
    }
  }, [applyRegionConfig]);

  useEffect(() => {
    const loadRegions = async () => {
      try {
        const response = await fetch('/api/regions', { cache: 'no-store' });
        if (!response.ok) throw new Error('无法读取区域配置');
        const data = await response.json() as { casesXml: string; fieldsXml: string };
        applyRegionConfig(data.casesXml, data.fieldsXml, '项目默认配置');
      } catch (cause) {
        setRegionError(cause instanceof Error ? cause.message : '区域配置解析失败');
      }
    };
    loadRegions();
  }, [applyRegionConfig]);

  useEffect(() => {
    if (!stats || !initialRegionsRef.current) return;
    setRegionInstances((current) => current.map((instance) => ({
      ...instance,
      start: 0,
      end: Math.max(stats.duration, 0.05),
    })));
    initialRegionsRef.current = false;
  }, [stats]);

  useEffect(() => {
    viewerRef.current?.setRegions(caseDefinitions, regionInstances);
  }, [caseDefinitions, regionInstances]);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    setError('');
    setProgress({ label: '下载点云', value: 0 });
    try {
      const response = await fetch(`/api/pointcloud?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `读取失败 (${response.status})`);
      }
      const buffer = await readResponse(response, (value) => {
        setProgress({ label: '下载点云', value });
      });
      const fileName = response.headers.get('X-Pointcloud-File') ?? 'latest-pointcloud.ply';
      await viewerRef.current?.loadBuffer(buffer, fileName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取点云');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.ply')) {
      setError('请选择 .ply 点云文件');
      return;
    }
    setLoading(true);
    setError('');
    setProgress({ label: '读取本地文件', value: 0 });
    try {
      const buffer = await readLocalFile(file, (value) => {
        setProgress({ label: '读取本地文件', value });
      });
      await viewerRef.current?.loadBuffer(buffer, file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'PLY 文件解析失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#070b0d');
    scene.fog = new THREE.FogExp2('#070b0d', 0.008);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 10000);
    camera.up.set(0, 0, 1);
    camera.position.set(8, -8, 6);

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    let queuedRenderFrame = 0;
    const requestSceneRender = () => {
      if (queuedRenderFrame) return;
      queuedRenderFrame = requestAnimationFrame(() => {
        queuedRenderFrame = 0;
        renderer.render(scene, camera);
      });
    };

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 2.2;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.45;
    controls.staticMoving = false;
    controls.dynamicDampingFactor = 0.1;
    controls.target.set(0, 0, 1);

    const grid = new THREE.GridHelper(20, 20, '#275a61', '#14282d');
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const axes = new THREE.AxesHelper(2.5);
    scene.add(axes);

    const pivotMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 12),
      new THREE.MeshBasicMaterial({
        color: '#ffca68',
        depthTest: false,
        transparent: true,
        opacity: 0.92,
      })
    );
    pivotMarker.visible = false;
    pivotMarker.renderOrder = 10;
    scene.add(pivotMarker);

    const regionRoot = new THREE.Group();
    regionRoot.name = 'monitoring-case-regions';
    regionRoot.scale.z = timeScaleRef.current;
    scene.add(regionRoot);

    const regionGroups = new Map<string, THREE.Group>();
    let currentRegionDefinitions: CaseDefinition[] | null = null;

    const disposeRegionObject = (root: THREE.Object3D) => {
      root.traverse((object) => {
        const renderable = object as THREE.Mesh | THREE.LineSegments;
        renderable.geometry?.dispose();
        if (Array.isArray(renderable.material)) renderable.material.forEach((material) => material.dispose());
        else renderable.material?.dispose();
      });
    };

    const clearRegions = () => {
      for (const child of [...regionRoot.children]) disposeRegionObject(child);
      regionRoot.clear();
      regionGroups.clear();
      currentRegionDefinitions = null;
    };

    const createRegionGroup = (definition: CaseDefinition) => {
      const instanceGroup = new THREE.Group();
      for (const field of definition.fields) {
        const [first, ...rest] = field.points;
        if (!first) continue;
        const shape = new THREE.Shape();
        shape.moveTo(first[0], first[1]);
        for (const [x, y] of rest) shape.lineTo(x, y);
        shape.closePath();

        // Unit-depth geometry is created only once. Time edits are transforms.
        const geometry = new THREE.ExtrudeGeometry(shape, {
          depth: 1,
          bevelEnabled: false,
          steps: 1,
        });
        const material = new THREE.MeshBasicMaterial({
          color: definition.color,
          transparent: true,
          opacity: 0.14,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const volume = new THREE.Mesh(geometry, material);
        volume.renderOrder = 2;
        instanceGroup.add(volume);

        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry, 20),
          new THREE.LineBasicMaterial({
            color: definition.color,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
          })
        );
        outline.renderOrder = 3;
        instanceGroup.add(outline);
      }
      return instanceGroup;
    };

    const renderRegions = (definitions: CaseDefinition[], instances: RegionInstance[]) => {
      if (definitions !== currentRegionDefinitions) {
        clearRegions();
        currentRegionDefinitions = definitions;
      }

      const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
      const activeIds = new Set(instances.map((instance) => instance.id));
      for (const [id, group] of regionGroups) {
        if (activeIds.has(id)) continue;
        regionRoot.remove(group);
        disposeRegionObject(group);
        regionGroups.delete(id);
      }

      for (const instance of instances) {
        const definition = definitionsById.get(instance.caseId);
        if (!definition) continue;
        let instanceGroup = regionGroups.get(instance.id);
        if (!instanceGroup) {
          instanceGroup = createRegionGroup(definition);
          regionGroups.set(instance.id, instanceGroup);
          regionRoot.add(instanceGroup);
        }
        instanceGroup.name = `${definition.name} ${instance.start.toFixed(2)}-${instance.end.toFixed(2)}`;
        instanceGroup.visible = instance.visible && instance.end > instance.start;
        instanceGroup.position.z = instance.start;
        instanceGroup.scale.z = Math.max(instance.end - instance.start, 0.001);
      }
      requestSceneRender();
    };

    let cloud: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
    let autoRotateEnabled = false;
    const autoRotateAxis = new THREE.Vector3(0, 0, 1);

    const fitCamera = () => {
      if (!cloud) return;
      const box = new THREE.Box3().setFromObject(cloud);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 1);
      const distance = radius / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.65;
      camera.position.copy(center).add(new THREE.Vector3(1, -1, 0.72).normalize().multiplyScalar(distance));
      camera.near = Math.max(distance / 10000, 0.001);
      camera.far = distance * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      pivotMarker.position.copy(center);
      pivotMarker.scale.setScalar(Math.max(radius * 0.008, 0.015));
      pivotMarker.visible = true;
      controls.update();
      renderer.render(scene, camera);
    };

    const centerPivot = () => {
      if (!cloud) return;
      const box = new THREE.Box3().setFromObject(cloud);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 1);
      controls.target.copy(center);
      pivotMarker.position.copy(center);
      pivotMarker.scale.setScalar(Math.max(radius * 0.008, 0.015));
      pivotMarker.visible = true;
      controls.update();
      renderer.render(scene, camera);
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pickPivot = (event: MouseEvent) => {
      if (!cloud) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const box = new THREE.Box3().setFromObject(cloud);
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 1);
      raycaster.params.Points = { threshold: Math.max(radius * 0.012, 0.02) };
      const hit = raycaster.intersectObject(cloud, false)[0];
      if (!hit) return;

      controls.target.copy(hit.point);
      pivotMarker.position.copy(hit.point);
      pivotMarker.scale.setScalar(Math.max(radius * 0.008, 0.015));
      pivotMarker.visible = true;
      controls.update();
      renderer.render(scene, camera);
    };
    renderer.domElement.addEventListener('dblclick', pickPivot);

    viewerRef.current = {
      async loadBuffer(buffer, fileName) {
        setProgress({ label: '解析并优化点云', value: 0 });
        const parsed = await parsePointCloud(buffer, (value) => {
          setProgress({ label: '解析并优化点云', value });
        });
        setProgress({ label: '上传至 GPU', value: 0.95 });

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(parsed.positions), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(parsed.colors), 3));

        geometry.computeBoundingBox();
        const material = new THREE.PointsMaterial({
          size: pointSizeRef.current,
          sizeAttenuation: false,
          vertexColors: geometry.hasAttribute('color'),
        });

        if (cloud) {
          scene.remove(cloud);
          cloud.geometry.dispose();
          cloud.material.dispose();
        }

        cloud = new THREE.Points(geometry, material);
        cloud.scale.z = timeScaleRef.current;
        scene.add(cloud);
        fitCamera();
        renderer.render(scene, camera);
        const nextStats = {
          sourcePoints: parsed.sourcePoints,
          renderedPoints: parsed.renderedPoints,
          duration: parsed.maxTime - parsed.minTime,
          fileName,
        };
        statsRef.current = nextStats;
        setStats(nextStats);
        setProgress({ label: '完成', value: 1 });
      },
      setPointSize(size) {
        if (cloud) {
          cloud.material.size = size;
          renderer.render(scene, camera);
        }
      },
      setTimeScale(scale) {
        if (cloud) {
          cloud.scale.z = scale;
        }
        regionRoot.scale.z = scale;
        renderer.render(scene, camera);
      },
      setAutoRotate(enabled) {
        autoRotateEnabled = enabled;
      },
      setRegions: renderRegions,
      centerPivot,
      resetCamera: fitCamera,
    };

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      controls.handleResize();
      renderer.render(scene, camera);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame = 0;
    const renderOnChange = () => {
      if (pivotMarker.visible) pivotMarker.position.copy(controls.target);
      renderer.render(scene, camera);
    };
    controls.addEventListener('change', renderOnChange);
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (autoRotateEnabled) {
        const offset = camera.position.clone().sub(controls.target);
        offset.applyAxisAngle(autoRotateAxis, 0.003);
        camera.up.applyAxisAngle(autoRotateAxis, 0.003);
        camera.position.copy(controls.target).add(offset);
      }
      controls.update();
    };
    animate();
    loadLatest();

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(queuedRenderFrame);
      observer.disconnect();
      controls.removeEventListener('change', renderOnChange);
      renderer.domElement.removeEventListener('dblclick', pickPivot);
      controls.dispose();
      cloud?.geometry.dispose();
      cloud?.material.dispose();
      renderer.dispose();
      clearRegions();
      pivotMarker.geometry.dispose();
      pivotMarker.material.dispose();
      renderer.domElement.remove();
      viewerRef.current = null;
    };
    // Scene lifetime is intentionally independent from UI control state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLatest]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) loadFile(file);
  };

  return (
    <main
      className={`viewer-shell ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div ref={viewportRef} className="viewport" />

      <header className="topbar">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div>
          <p className="eyebrow">SICK MICROSCAN3</p>
          <h1>Temporal Point Cloud</h1>
        </div>
        <div className="live-badge"><i /> XY + TIME</div>
      </header>

      <aside className="control-panel glass-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">DATASET</p>
            <h2>{stats?.fileName ?? '等待点云'}</h2>
          </div>
          <button className="icon-button" onClick={loadLatest} title="读取最新点云">↻</button>
        </div>

        <div className="metrics">
          <div>
            <span>DISPLAYED / TOTAL</span>
            <strong>{stats ? `${formatPoints(stats.renderedPoints)} / ${formatPoints(stats.sourcePoints)}` : '—'}</strong>
          </div>
          <div><span>DURATION</span><strong>{stats ? `${stats.duration.toFixed(2)}s` : '—'}</strong></div>
        </div>

        <label className="range-control">
          <span><b>点大小</b><output>{pointSize.toFixed(1)} px</output></span>
          <input type="range" min="1" max="6" step="0.5" value={pointSize} onChange={(event) => {
            const value = Number(event.target.value);
            setPointSize(value);
            pointSizeRef.current = value;
            viewerRef.current?.setPointSize(value);
          }} />
        </label>

        <label className="range-control">
          <span><b>时间轴比例</b><output>{timeScale.toFixed(2)}×</output></span>
          <input type="range" min="0.01" max="1" step="0.01" value={timeScale} onChange={(event) => {
            const value = Number(event.target.value);
            setTimeScale(value);
            timeScaleRef.current = value;
            viewerRef.current?.setTimeScale(value);
          }} />
        </label>

        <div className="button-row">
          <button onClick={() => viewerRef.current?.resetCamera()}>适应画面</button>
          <button className={autoRotate ? 'active' : ''} onClick={() => {
            const value = !autoRotate;
            setAutoRotate(value);
            viewerRef.current?.setAutoRotate(value);
          }}>自动旋转</button>
          <button className="wide-button" onClick={() => viewerRef.current?.centerPivot()}>
            重置旋转中心
          </button>
        </div>

        <button className="file-button" onClick={() => fileInputRef.current?.click()}>
          <span>＋</span> 打开本地 PLY
        </button>
        <input ref={fileInputRef} hidden type="file" accept=".ply" onChange={onFileChange} />

        <div className="config-source">
          <span>DEVICE CONFIG</span>
          <strong title={configLabel}>{configLabel}</strong>
        </div>
        <button className="file-button config-button" onClick={() => regionFileInputRef.current?.click()}>
          <span>⇄</span> 切换设备配置
        </button>
        <input
          ref={regionFileInputRef}
          hidden
          type="file"
          multiple
          accept=".xml,.sdxml,.casesxml"
          onChange={(event) => {
            if (event.target.files?.length) loadRegionFiles(event.target.files);
            event.target.value = '';
          }}
        />

        {error && <p className="error-message">{error}</p>}
        {regionError && <p className="error-message">{regionError}</p>}
        {loading && (
          <div className="progress-block" role="status" aria-live="polite">
            <div><span>{progress.label}</span><output>{Math.round(progress.value * 100)}%</output></div>
            <div className="progress-track"><span style={{ width: `${progress.value * 100}%` }} /></div>
          </div>
        )}
      </aside>

      {caseDefinitions.length > 0 && (
        <RegionTimeline
          cases={caseDefinitions}
          instances={regionInstances}
          duration={timelineDuration}
          setInstances={setRegionInstances}
        />
      )}

      <div className="axis-legend glass-panel">
        <span><i className="axis-x" />X · 米</span>
        <span><i className="axis-y" />Y · 米</span>
        <span><i className="axis-z" />Z · 时间（秒）</span>
      </div>

      <p className="hint">双击点云设置旋转中心 · 左键自由翻转 · 滚轮缩放 · 右键平移</p>

      {dragging && <div className="drop-overlay"><div><strong>释放以载入</strong><span>PLY POINT CLOUD</span></div></div>}
    </main>
  );
}
