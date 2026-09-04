'use client';

import { Dispatch, PointerEvent, SetStateAction, useRef, useState } from 'react';
import type { CaseDefinition, RegionInstance } from '../lib/region-config';

type Props = {
  cases: CaseDefinition[];
  instances: RegionInstance[];
  duration: number;
  setInstances: Dispatch<SetStateAction<RegionInstance[]>>;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export default function RegionTimeline({ cases, instances, duration, setInstances }: Props) {
  const trackRefs = useRef(new Map<string, HTMLDivElement>());
  const [collapsed, setCollapsed] = useState(false);

  const startDrag = (
    event: PointerEvent,
    instance: RegionInstance,
    mode: 'move' | 'start' | 'end'
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const track = trackRefs.current.get(instance.caseId);
    if (!track) return;
    const originX = event.clientX;
    const originalStart = instance.start;
    const originalEnd = instance.end;
    const secondsPerPixel = duration / Math.max(track.clientWidth, 1);

    const move = (moveEvent: globalThis.PointerEvent) => {
      const delta = (moveEvent.clientX - originX) * secondsPerPixel;
      setInstances((current) => current.map((item) => {
        if (item.id !== instance.id) return item;
        if (mode === 'start') return { ...item, start: clamp(originalStart + delta, 0, item.end - 0.05) };
        if (mode === 'end') return { ...item, end: clamp(originalEnd + delta, item.start + 0.05, duration) };
        const length = originalEnd - originalStart;
        const start = clamp(originalStart + delta, 0, Math.max(0, duration - length));
        return { ...item, start, end: start + length };
      }));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  };

  const addInstance = (caseId: string) => {
    const count = instances.filter((instance) => instance.caseId === caseId).length;
    const length = Math.max(duration * 0.2, 0.5);
    const start = Math.min((count * duration * 0.12) % Math.max(duration, 1), Math.max(0, duration - length));
    setInstances((current) => [...current, {
      id: `${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      caseId,
      start,
      end: Math.min(duration, start + length),
      visible: true,
    }]);
  };

  const toggleCase = (caseId: string) => {
    const caseInstances = instances.filter((instance) => instance.caseId === caseId);
    const nextVisible = !caseInstances.some((instance) => instance.visible);
    setInstances((current) => current.map((instance) =>
      instance.caseId === caseId ? { ...instance, visible: nextVisible } : instance
    ));
  };

  return (
    <section className={`timeline-panel glass-panel ${collapsed ? 'is-collapsed' : ''}`}>
      <header className="timeline-heading">
        <div>
          <p className="eyebrow">MONITORING CASES</p>
          <h2>区域时间编排</h2>
        </div>
        <button onClick={() => setCollapsed((value) => !value)}>{collapsed ? '展开' : '收起'}</button>
      </header>

      {!collapsed && (
        <div className="timeline-content">
          <div className="timeline-ruler">
            <span>0s</span><span>{(duration * 0.25).toFixed(1)}s</span>
            <span>{(duration * 0.5).toFixed(1)}s</span><span>{(duration * 0.75).toFixed(1)}s</span>
            <span>{duration.toFixed(1)}s</span>
          </div>

          {cases.map((definition) => {
            const items = instances.filter((instance) => instance.caseId === definition.id);
            const visible = items.some((instance) => instance.visible);
            return (
              <div className="timeline-row" key={definition.id}>
                <div className="case-label">
                  <button
                    className={`visibility-dot ${visible ? '' : 'is-off'}`}
                    style={{ '--case-color': definition.color } as React.CSSProperties}
                    onClick={() => toggleCase(definition.id)}
                    title={visible ? '隐藏此 Case' : '显示此 Case'}
                  />
                  <span title={definition.name}>{definition.name}</span>
                  <small>{definition.fields.length} fields</small>
                  <button className="add-region" onClick={() => addInstance(definition.id)} title="添加时间实例">＋</button>
                </div>
                <div
                  className="case-track"
                  ref={(node) => {
                    if (node) trackRefs.current.set(definition.id, node);
                    else trackRefs.current.delete(definition.id);
                  }}
                >
                  {items.map((instance, itemIndex) => (
                    <div
                      className={`region-bar ${instance.visible ? '' : 'is-hidden'}`}
                      key={instance.id}
                      style={{
                        '--case-color': definition.color,
                        left: `${instance.start / duration * 100}%`,
                        width: `${Math.max((instance.end - instance.start) / duration * 100, 0.8)}%`,
                        top: `${3 + (itemIndex % 3) * 4}px`,
                      } as React.CSSProperties}
                      onPointerDown={(event) => startDrag(event, instance, 'move')}
                      title={`${instance.start.toFixed(2)}s – ${instance.end.toFixed(2)}s`}
                    >
                      <i className="resize-handle start" onPointerDown={(event) => startDrag(event, instance, 'start')} />
                      <span>{instance.start.toFixed(1)}–{instance.end.toFixed(1)}s</span>
                      <button onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                        setInstances((current) => current.filter((item) => item.id !== instance.id));
                      }}>×</button>
                      <i className="resize-handle end" onPointerDown={(event) => startDrag(event, instance, 'end')} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
