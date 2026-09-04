import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POINT_CLOUD_PATTERN = /^sick_pointcloud_\d{8}_\d{6}\.ply$/;

export async function GET() {
  const root = process.cwd();
  const names = (await readdir(root)).filter((name) => POINT_CLOUD_PATTERN.test(name));

  if (names.length === 0) {
    return Response.json(
      { error: '当前目录中还没有 sick_pointcloud_*.ply 文件' },
      { status: 404 }
    );
  }

  const candidates = await Promise.all(
    names.map(async (name) => ({ name, info: await stat(path.join(root, name)) }))
  );
  candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);

  const latest = candidates[0];
  const stream = Readable.toWeb(createReadStream(path.join(root, latest.name)));

  return new Response(stream as ReadableStream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(latest.info.size),
      'Content-Disposition': `inline; filename="${latest.name}"`,
      'X-Pointcloud-File': latest.name,
      'Cache-Control': 'no-store',
    },
  });
}
