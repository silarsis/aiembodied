/**
 * `aiembodied-asset://polyhaven/<id>/<file>` serves files from the room asset cache
 * (`<userData>/rooms/assets`) to the renderer, and nothing else. The path logic is pure so it can
 * be tested; `registerAssetProtocol` wires it to Electron's `protocol.handle`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ASSET_SCHEME = 'aiembodied-asset';

export const ASSET_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } as const;

const MIME: Record<string, string> = {
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** The absolute file a request URL names inside `root`, or null if it is not a clean path under it. */
export function resolveAssetPath(root: string, requestUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:`) return null;
  const raw = [parsed.hostname, ...parsed.pathname.split('/').slice(1)];
  const segments: string[] = [];
  for (const part of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!segment || segment === '.' || segment === '..' || /[\\/:\0]/.test(segment)) return null;
    segments.push(segment);
  }
  if (segments.length < 2) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, ...segments);
  return file.startsWith(base + path.sep) ? file : null;
}

export interface ProtocolLike {
  handle(scheme: string, handler: (request: { url: string }) => Promise<Response> | Response): void;
}

export function registerAssetProtocol(protocol: ProtocolLike, root: string): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const file = resolveAssetPath(root, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const data = await readFile(file);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': mimeFor(file), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
