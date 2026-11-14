/**
 * What the room hub needs to serve the renderer build to a browser (the web satellite, docs/features/satellite.md),
 * and the checks that keep that safe. Pure Node (fs, path); no Electron.
 *
 * - `resolveWebPath` turns a request path under `/app/` into a file inside the dist folder, or null. It never
 *   returns anything outside the folder: odd segments are refused, and `serveStaticFile` checks the real path
 *   again (symlinks) before it reads a byte.
 * - `hostAllowed` and `originAllowed` stop a web page on another site from reaching the hub through the browser
 *   (including DNS rebinding, where a hostile name points at 127.0.0.1).
 */
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const WEB_PREFIX = '/app/';
/** The origin of the Android shell's WebView (the next PR). It proxies every request to the hub. */
export const ANDROID_SHELL_ORIGIN = 'https://appassets.androidplatform.net';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrma': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function contentTypeFor(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The file a request path names under `/app/`, or null when the path is not a clean one. `/app/` is `index.html`.
 * Refused: `..` and `.` segments (also when percent-encoded), empty segments, backslashes, colons, NUL, and any
 * segment that starts with a dot (so no `.env`, `.git`). A trailing slash on a folder is refused by the caller
 * (it is a directory, and directories are never listed).
 */
export function resolveWebPath(root: string, pathname: string): string | null {
  if (!pathname.startsWith(WEB_PREFIX)) return null;
  const rest = pathname.slice(WEB_PREFIX.length);
  const base = path.resolve(root);
  if (rest === '') return path.join(base, 'index.html');
  const segments: string[] = [];
  for (const part of rest.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!segment || segment.startsWith('.') || /[\\/:\0]/.test(segment)) return null;
    segments.push(segment);
  }
  const file = path.resolve(base, ...segments);
  return file.startsWith(base + path.sep) ? file : null;
}

/** Cache rules: the page itself is always asked again; hashed bundle files never change under their name. */
function cacheControlFor(relative: string): string {
  if (relative === 'index.html') return 'no-cache';
  if (relative.startsWith(`assets${path.sep}`)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

/**
 * The app's CSP lets the page connect to itself only (`connect-src 'self'`). A web satellite also opens the room link
 * WebSocket, which in the Android shell goes to the hub while the page comes from the shell's own origin, and older
 * browsers do not count `ws:` as 'self'. So the copy of index.html the hub serves names the hub it came from, and
 * nothing wider. The Electron app loads index.html from disk and keeps the original policy.
 */
export function withHubConnectSrc(html: string, hostHeader: string | undefined): string {
  const host = (hostHeader ?? '').toLowerCase();
  if (!/^[a-z0-9.\-[\]:]+$/.test(host) || !splitHost(host)) return html;
  return html.replace(/connect-src ([^;"]*)/, (match, sources: string) => `connect-src ${sources.trim()} ws://${host} wss://${host}`);
}

/**
 * Sends one file of the dist folder (GET only; the caller has checked the method). 404 for anything that is not a
 * regular file inside the folder. Returns the status it answered with.
 */
export async function serveStaticFile(root: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<number> {
  const plain = (status: number, text: string, headers: Record<string, string> = {}): number => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(text);
    return status;
  };
  const candidate = resolveWebPath(root, pathname);
  if (!candidate) return plain(404, 'Not found');
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(candidate), realpath(root)]);
  } catch {
    return plain(404, 'Not found');
  }
  // A symlink inside the folder must not lead out of it.
  if (!real.startsWith(realRoot + path.sep)) return plain(404, 'Not found');
  let info;
  try {
    info = await stat(real);
  } catch {
    return plain(404, 'Not found');
  }
  if (!info.isFile()) return plain(404, 'Not found');
  if (path.relative(realRoot, real) === 'index.html') {
    // The page itself: with the hub's own address added to the CSP, and never cached.
    const html = withHubConnectSrc(await readFile(real, 'utf8'), req.headers.host);
    res.writeHead(200, { 'Content-Type': contentTypeFor(real), 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(html);
    return 200;
  }
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': contentTypeFor(real),
    'Cache-Control': cacheControlFor(path.relative(realRoot, real)),
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    ...SECURITY_HEADERS,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return 304;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  await new Promise<void>((resolve) => {
    const stream = createReadStream(real);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.on('end', () => resolve());
    stream.pipe(res);
  });
  return 200;
}

// -- Host and Origin ---------------------------------------------------------------------------------

/** `host` or `host:port` from a Host header or an origin, lower case, with the port split off. Null when it is not one. */
function splitHost(value: string): { host: string; port: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return null;
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  return { host: parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port: parsed.port };
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Is this Host header one the hub expects to be called by? Yes for an IP address (the hub only listens on loopback
 * and Tailscale addresses, so nobody else can reach it by IP), `localhost`, a name without dots (MagicDNS short
 * names such as `bija`) and `*.ts.net`. A name with dots that is anything else is refused: that is what a rebinding
 * attack looks like (`evil.example` answering with 127.0.0.1). `extra` is `ROOM_HUB_ALLOWED_HOSTS`.
 */
export function hostAllowed(hostHeader: string | undefined, extra: readonly string[] = []): boolean {
  if (!hostHeader) return false;
  const parts = splitHost(hostHeader);
  if (!parts) return false;
  const { host } = parts;
  if (isIpLiteral(host) || host === 'localhost' || !host.includes('.') || host.endsWith('.ts.net')) return true;
  return extra.map((name) => name.trim().toLowerCase()).includes(host);
}

/**
 * May a page from this Origin talk to the hub? An absent Origin is a program, not a web page (the Electron
 * satellite, curl): yes. Otherwise the page must come from the hub itself (its own host and port, and the Host
 * header must be one `hostAllowed` accepts), from loopback on the hub's port, or from the Android shell.
 */
export function originAllowed(origin: string | undefined, hostHeader: string | undefined, hubPort: number | null, extraHosts: readonly string[] = []): boolean {
  if (origin === undefined) return true;
  if (origin === ANDROID_SHELL_ORIGIN) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.pathname !== '/') return false;
  const from = splitHost(parsed.host);
  if (!from) return false;
  const effectivePort = (port: string, protocol: string) => port || (protocol === 'https:' ? '443' : '80');
  if (hubPort !== null && from.host === '127.0.0.1' && effectivePort(from.port, parsed.protocol) === String(hubPort)) return true;
  // The hub's own host: the page was loaded from the very name and port it now calls.
  if (!hostHeader || !hostAllowed(hostHeader, extraHosts)) return false;
  const to = splitHost(hostHeader);
  if (!to) return false;
  return from.host === to.host && effectivePort(from.port, parsed.protocol) === effectivePort(to.port, parsed.protocol);
}
