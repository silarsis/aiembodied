import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANDROID_SHELL_ORIGIN, contentTypeFor, hostAllowed, originAllowed, resolveWebPath, withHubConnectSrc } from '../../src/room-hub/web-serve.js';

const ROOT = path.resolve('/srv/dist');

describe('resolveWebPath', () => {
  it('maps /app/ to index.html and files to files under the root', () => {
    expect(resolveWebPath(ROOT, '/app/')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveWebPath(ROOT, '/app/assets/index-abc.js')).toBe(path.join(ROOT, 'assets', 'index-abc.js'));
    expect(resolveWebPath(ROOT, '/app/models/a%20b.tflite')).toBe(path.join(ROOT, 'models', 'a b.tflite'));
  });

  it('refuses traversal in every spelling, odd segments, dotfiles and other prefixes', () => {
    for (const bad of [
      '/app/../secret',
      '/app/assets/../../secret',
      '/app/%2e%2e/secret',
      '/app/%2E%2E%2Fsecret',
      '/app/assets/%2e%2e/%2e%2e/secret',
      '/app/..%2fsecret',
      '/app/a\\..\\b',
      '/app/%5c..%5csecret',
      '/app/C:/Windows/win.ini',
      '/app/a%00.js',
      '/app//etc/passwd',
      '/app/./index.html',
      '/app/.env',
      '/app/assets/.git/config',
      '/app/%',
      '/application/index.html',
      '/v1/link',
    ]) {
      expect(resolveWebPath(ROOT, bad), bad).toBeNull();
    }
  });
});

describe('contentTypeFor', () => {
  it('knows the types the app needs, including wasm, tflite, vrm and glb', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('vision_wasm_internal.wasm')).toBe('application/wasm');
    expect(contentTypeFor('face.tflite')).toBe('application/octet-stream');
    expect(contentTypeFor('body.vrm')).toBe('model/gltf-binary');
    expect(contentTypeFor('chair.GLB')).toBe('model/gltf-binary');
    expect(contentTypeFor('chair.gltf')).toBe('model/gltf+json');
    expect(contentTypeFor('x.unknown')).toBe('application/octet-stream');
  });
});

describe('hostAllowed', () => {
  it('accepts IP addresses, localhost, short names and *.ts.net, with or without a port', () => {
    for (const ok of ['127.0.0.1:8791', '100.64.1.2:8791', '[::1]:8791', 'localhost:8791', 'bija:8791', 'bija', 'bija.tail1234.ts.net', 'bija.tail1234.ts.net:443']) {
      expect(hostAllowed(ok), ok).toBe(true);
    }
  });

  it('refuses a public name pointing at the hub (DNS rebinding), nothing, and junk', () => {
    for (const bad of ['evil.example:8791', 'evil.example', 'bija.evil.com', undefined, '', 'a b', 'user@bija', 'bija/x']) {
      expect(hostAllowed(bad), String(bad)).toBe(false);
    }
  });

  it('accepts a name the owner listed in ROOM_HUB_ALLOWED_HOSTS', () => {
    expect(hostAllowed('bija.home.arpa:8791', ['bija.home.arpa'])).toBe(true);
    expect(hostAllowed('other.home.arpa:8791', ['bija.home.arpa'])).toBe(false);
  });
});

describe('originAllowed', () => {
  it('lets a program through (no Origin) and refuses a page of another site', () => {
    expect(originAllowed(undefined, '127.0.0.1:8791', 8791)).toBe(true);
    expect(originAllowed('https://evil.example', '127.0.0.1:8791', 8791)).toBe(false);
    expect(originAllowed('http://evil.example:8791', '127.0.0.1:8791', 8791)).toBe(false);
    expect(originAllowed('null', '127.0.0.1:8791', 8791)).toBe(false);
    expect(originAllowed('file://', '127.0.0.1:8791', 8791)).toBe(false);
    expect(originAllowed('http://127.0.0.1:9999', '127.0.0.1:8791', 8791)).toBe(false);
    expect(originAllowed('http://user:pw@127.0.0.1:8791', '127.0.0.1:8791', 8791)).toBe(false);
  });

  it('accepts the hub on loopback, the hub\'s own host and the Android shell', () => {
    expect(originAllowed('http://127.0.0.1:8791', '127.0.0.1:8791', 8791)).toBe(true);
    expect(originAllowed('https://127.0.0.1:8791', '127.0.0.1:8791', 8791)).toBe(true);
    expect(originAllowed('http://100.64.1.2:8791', '100.64.1.2:8791', 8791)).toBe(true);
    expect(originAllowed('http://bija:8791', 'bija:8791', 8791)).toBe(true);
    expect(originAllowed('https://bija.tail1234.ts.net', 'bija.tail1234.ts.net', 8791)).toBe(true);
    expect(originAllowed(ANDROID_SHELL_ORIGIN, '100.64.1.2:8791', 8791)).toBe(true);
    expect(originAllowed('http://appassets.androidplatform.net', '100.64.1.2:8791', 8791)).toBe(false);
  });

  it('refuses a page whose Host is a rebinding name, even when Origin and Host agree', () => {
    expect(originAllowed('http://evil.example:8791', 'evil.example:8791', 8791)).toBe(false);
  });

  it('refuses when the Origin host differs from the Host the request was made to', () => {
    expect(originAllowed('http://bija:8791', '100.64.1.2:8791', 8791)).toBe(false);
  });
});

describe('withHubConnectSrc', () => {
  const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' blob: https://api.openai.com; media-src 'self'">`;

  it('adds the hub the page came from to connect-src, and nothing else', () => {
    const out = withHubConnectSrc(html, '100.64.1.2:8791');
    expect(out).toContain("connect-src 'self' blob: https://api.openai.com ws://100.64.1.2:8791 wss://100.64.1.2:8791;");
    expect(out).toContain("default-src 'self';");
    expect(out).not.toContain('ws: ');
  });

  it('leaves the policy as it is for a Host that could carry more than a host', () => {
    for (const bad of ["a;script-src *", 'a b', 'a"b', undefined, '']) expect(withHubConnectSrc(html, bad)).toBe(html);
  });
});
