import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const configDirectory = path.join(process.cwd(), 'config');
    const [casesXml, fieldsXml] = await Promise.all([
      readFile(path.join(configDirectory, 'monitoring.casesxml'), 'utf8'),
      readFile(path.join(configDirectory, 'scope.sdxml'), 'utf8'),
    ]);
    return Response.json(
      {
        casesXml: casesXml.replace(/^\uFEFF/, ''),
        fieldsXml: fieldsXml.replace(/^\uFEFF/, ''),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return Response.json({ error: '无法读取区域配置文件' }, { status: 404 });
  }
}
