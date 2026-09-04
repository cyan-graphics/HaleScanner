/// <reference lib="webworker" />

type ScalarType = {
  size: number;
  read: (view: DataView, offset: number) => number;
  normalizedColor?: boolean;
};

type Property = {
  name: string;
  offset: number;
  type: ScalarType;
};

const scalarTypes: Record<string, ScalarType> = {
  char: { size: 1, read: (v, o) => v.getInt8(o) },
  int8: { size: 1, read: (v, o) => v.getInt8(o) },
  uchar: { size: 1, read: (v, o) => v.getUint8(o), normalizedColor: true },
  uint8: { size: 1, read: (v, o) => v.getUint8(o), normalizedColor: true },
  short: { size: 2, read: (v, o) => v.getInt16(o, true) },
  int16: { size: 2, read: (v, o) => v.getInt16(o, true) },
  ushort: { size: 2, read: (v, o) => v.getUint16(o, true) },
  uint16: { size: 2, read: (v, o) => v.getUint16(o, true) },
  int: { size: 4, read: (v, o) => v.getInt32(o, true) },
  int32: { size: 4, read: (v, o) => v.getInt32(o, true) },
  uint: { size: 4, read: (v, o) => v.getUint32(o, true) },
  uint32: { size: 4, read: (v, o) => v.getUint32(o, true) },
  float: { size: 4, read: (v, o) => v.getFloat32(o, true) },
  float32: { size: 4, read: (v, o) => v.getFloat32(o, true) },
  double: { size: 8, read: (v, o) => v.getFloat64(o, true) },
  float64: { size: 8, read: (v, o) => v.getFloat64(o, true) },
};

function findHeaderEnd(bytes: Uint8Array) {
  const marker = new TextEncoder().encode('end_header');
  outer: for (let i = 0; i <= bytes.length - marker.length; i += 1) {
    for (let j = 0; j < marker.length; j += 1) {
      if (bytes[i + j] !== marker[j]) continue outer;
    }
    let end = i + marker.length;
    while (end < bytes.length && bytes[end] !== 10) end += 1;
    return end + 1;
  }
  throw new Error('PLY header 不完整');
}

function heatColor(value: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, value / 255));
  return [
    Math.max(0, Math.min(1, 2 * t - 0.5)),
    Math.max(0, Math.min(1, 1.5 - 3 * Math.abs(t - 0.5))),
    Math.max(0, Math.min(1, 1.5 - 2 * t)),
  ];
}

self.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; maxPoints: number }>) => {
  try {
    const { buffer, maxPoints } = event.data;
    const bytes = new Uint8Array(buffer);
    const dataOffset = findHeaderEnd(bytes);
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, dataOffset));
    const lines = header.split(/\r?\n/);

    if (!lines.some((line) => line.trim() === 'format binary_little_endian 1.0')) {
      throw new Error('目前高性能模式只支持 pointcloud.py 生成的 binary_little_endian PLY');
    }

    let vertexCount = 0;
    let readingVertex = false;
    let stride = 0;
    const properties: Property[] = [];

    for (const rawLine of lines) {
      const parts = rawLine.trim().split(/\s+/);
      if (parts[0] === 'element') {
        readingVertex = parts[1] === 'vertex';
        if (readingVertex) vertexCount = Number(parts[2]);
      } else if (readingVertex && parts[0] === 'property') {
        if (parts[1] === 'list') throw new Error('不支持 vertex list property');
        const type = scalarTypes[parts[1]];
        if (!type) throw new Error(`不支持 PLY 属性类型：${parts[1]}`);
        properties.push({ name: parts[2], offset: stride, type });
        stride += type.size;
      }
    }

    if (!Number.isFinite(vertexCount) || vertexCount <= 0 || stride <= 0) {
      throw new Error('PLY 中没有有效的 vertex 数据');
    }
    if (dataOffset + vertexCount * stride > buffer.byteLength) {
      throw new Error('PLY 数据长度与 header 不一致');
    }

    const byName = new Map(properties.map((property) => [property.name.toLowerCase(), property]));
    const x = byName.get('x');
    const y = byName.get('y');
    const z = byName.get('z');
    if (!x || !y || !z) throw new Error('PLY 缺少 x/y/z 坐标');

    const red = byName.get('red');
    const green = byName.get('green');
    const blue = byName.get('blue');
    const rssi = byName.get('rssi');
    const outputCount = Math.min(vertexCount, Math.max(1000, maxPoints));
    const positions = new Float32Array(outputCount * 3);
    const colors = new Float32Array(outputCount * 3);
    const view = new DataView(buffer);
    const sampleStep = vertexCount / outputCount;
    let minTime = Infinity;
    let maxTime = -Infinity;

    for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
      const sourceIndex = Math.min(vertexCount - 1, Math.floor(outputIndex * sampleStep));
      const base = dataOffset + sourceIndex * stride;
      const target = outputIndex * 3;
      const px = x.type.read(view, base + x.offset);
      const py = y.type.read(view, base + y.offset);
      const pz = z.type.read(view, base + z.offset);
      positions[target] = px;
      positions[target + 1] = py;
      positions[target + 2] = pz;
      minTime = Math.min(minTime, pz);
      maxTime = Math.max(maxTime, pz);

      if (red && green && blue) {
        const divisor = red.type.normalizedColor ? 255 : 1;
        colors[target] = red.type.read(view, base + red.offset) / divisor;
        colors[target + 1] = green.type.read(view, base + green.offset) / divisor;
        colors[target + 2] = blue.type.read(view, base + blue.offset) / divisor;
      } else if (rssi) {
        const color = heatColor(rssi.type.read(view, base + rssi.offset));
        colors[target] = color[0];
        colors[target + 1] = color[1];
        colors[target + 2] = color[2];
      } else {
        colors[target] = 0.36;
        colors[target + 1] = 0.95;
        colors[target + 2] = 0.85;
      }

      if (outputIndex % 20000 === 0) {
        self.postMessage({ type: 'progress', value: outputIndex / outputCount });
      }
    }

    self.postMessage(
      {
        type: 'complete',
        positions: positions.buffer,
        colors: colors.buffer,
        sourcePoints: vertexCount,
        renderedPoints: outputCount,
        minTime,
        maxTime,
      },
      { transfer: [positions.buffer, colors.buffer] }
    );
  } catch (cause) {
    self.postMessage({
      type: 'error',
      message: cause instanceof Error ? cause.message : 'PLY 解析失败',
    });
  }
};

export {};
