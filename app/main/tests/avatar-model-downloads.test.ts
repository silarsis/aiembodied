import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  comfyFolderFor,
  kindForBaseModel,
  lookupCivitai,
  parseCivitaiRef,
  planCivitaiDownload,
  type CivitaiModel,
} from '../src/avatar/generation/civitai.js';
import { createRemoteComfyModelScanner } from '../src/avatar/generation/image-model-service.js';
import { ModelDownloadService, type ModelDownload } from '../src/avatar/generation/model-downloads.js';
import type { ModelServer } from '../src/config/model-routing.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const civitaiModel = {
  id: 4201,
  name: 'Pony Realism',
  type: 'Checkpoint',
  modelVersions: [
    {
      id: 900,
      name: 'v2',
      baseModel: 'Pony',
      files: [
        { id: 11, name: 'pony_realism_v2.ckpt', sizeKB: 100, downloadUrl: 'https://civitai.com/api/download/models/900?format=PickleTensor', primary: false },
        { name: 'pony_realism_v2.safetensors', sizeKB: 6_000_000, downloadUrl: 'https://civitai.com/api/download/models/900', primary: true, hashes: { SHA256: 'ABC' } },
      ],
    },
    { id: 800, name: 'v1', baseModel: 'SD 1.5', files: [{ name: 'v1.safetensors', sizeKB: 2, downloadUrl: 'https://civitai.com/api/download/models/800', primary: true }] },
  ],
};

describe('Civitai references', () => {
  it('reads links, download links, AIRs and short ids', () => {
    expect(parseCivitaiRef('https://civitai.com/models/4201/pony-realism?modelVersionId=900')).toEqual({ modelId: 4201, versionId: 900 });
    expect(parseCivitaiRef('https://civitai.com/models/4201')).toEqual({ modelId: 4201 });
    expect(parseCivitaiRef('https://civitai.com/api/download/models/900')).toEqual({ versionId: 900 });
    expect(parseCivitaiRef('urn:air:sdxl:checkpoint:civitai:4201@900')).toEqual({ modelId: 4201, versionId: 900 });
    expect(parseCivitaiRef(' 4201@900 ')).toEqual({ modelId: 4201, versionId: 900 });
    expect(parseCivitaiRef('https://civitai.red/api/download/models/79913?fileId=54825')).toEqual({ versionId: 79913, fileId: 54825 });
    expect(parseCivitaiRef('https://civitai.green/models/4201')).toEqual({ modelId: 4201 });
    expect(parseCivitaiRef('https://civitai.evil.example/models/1')).toBeNull();
    expect(parseCivitaiRef('https://example.com/models/1')).toBeNull();
    expect(parseCivitaiRef('hello')).toBeNull();
  });

  it('looks a model up, picks the SafeTensors file, its folder and the image kind', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ck');
      return String(url).endsWith('/model-versions/900') ? json({ id: 900, modelId: 4201 }) : json(civitaiModel);
    }) as unknown as typeof fetch;
    const model = await lookupCivitai({ versionId: 900 }, 'ck', fetchFn);
    expect(model).toMatchObject({ modelId: 4201, name: 'Pony Realism', type: 'Checkpoint', versionId: 900 });
    const plan = planCivitaiDownload(model);
    expect(plan).toMatchObject({ folder: 'checkpoints', kind: 'sdxl', baseModel: 'Pony', title: 'Pony Realism · v2' });
    expect(plan.file).toMatchObject({ name: 'pony_realism_v2.safetensors', sha256: 'abc' });
    expect(plan.note).toBeUndefined();
    expect(planCivitaiDownload(model, 800)).toMatchObject({ kind: 'sd1', file: { name: 'v1.safetensors' } });
    // A download link's fileId picks that file; one from another version is ignored.
    expect(planCivitaiDownload(model, 900, 11).file.name).toBe('pony_realism_v2.ckpt');
    expect(planCivitaiDownload(model, 900, 999).file.name).toBe('pony_realism_v2.safetensors');
  });

  it('says when a download is not an image model the app can use', () => {
    const lora: CivitaiModel = { modelId: 1, name: 'Style', type: 'LORA', versionId: 2, versions: [{ id: 2, name: 'v1', baseModel: 'SDXL 1.0', files: [{ name: 's.safetensors', sizeKB: 1, downloadUrl: 'https://civitai.com/x', primary: true }] }] };
    expect(planCivitaiDownload(lora)).toMatchObject({ folder: 'loras', note: expect.stringContaining("isn't an image model") });
    const flux = { ...lora, type: 'Checkpoint', versions: [{ ...lora.versions[0], baseModel: 'Flux.1 D' }] };
    expect(planCivitaiDownload(flux).note).toContain('no workflow for Flux.1 D');
    expect(comfyFolderFor('Workflows')).toBeNull();
    expect(kindForBaseModel('Illustrious')).toBe('sdxl');
    expect(kindForBaseModel('SD 1.5 LCM')).toBe('sd1');
  });

  it('explains a refused or missing model', async () => {
    await expect(lookupCivitai({ modelId: 1 }, undefined, vi.fn(async () => json({}, 404)) as unknown as typeof fetch)).rejects.toThrow('no model');
    await expect(lookupCivitai({ modelId: 1 }, undefined, vi.fn(async () => json({}, 401)) as unknown as typeof fetch)).rejects.toThrow('API key');
  });
});

const plan = planCivitaiDownload({
  modelId: 4201,
  name: 'Pony Realism',
  type: 'Checkpoint',
  versionId: 900,
  versions: [{ id: 900, name: 'v2', baseModel: 'Pony', files: [{ name: 'p.safetensors', sizeKB: 1, downloadUrl: 'https://civitai.com/api/download/models/900', primary: true, sha256: 'abc' }] }],
});
const here: ModelServer = { id: 'local-comfy', name: 'ComfyUI on this PC', type: 'comfy', url: 'http://127.0.0.1:8188', builtIn: true, managed: true };
const rack: ModelServer = { id: 'rack', name: 'Rack', type: 'comfy', url: 'http://rack:8188', builtIn: false, managed: false };

async function settle(service: ModelDownloadService, id: string): Promise<ModelDownload> {
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(service.list().find((entry) => entry.id === id)?.state));
  return service.list().find((entry) => entry.id === id)!;
}

describe('model downloads', () => {
  it('runs the downloader with ComfyUI’s Python on this PC, passing the key in the environment', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawnFn = vi.fn(() => {
      setTimeout(() => {
        child.stdout.write('{"state":"downloading","received":10,"total":20}\n');
        child.stdout.end('{"state":"done","received":20,"total":20}\n');
        setTimeout(() => child.emit('close', 0), 5);
      }, 5);
      return child;
    });
    const onFinished = vi.fn();
    const service = new ModelDownloadService({
      script: '/addon/aiembodied_downloader.py',
      resolveInstallation: async () => ({ directory: '/comfy', python: '/comfy/python', modelPaths: '/x.yaml', env: { PATH: '/bin' } }),
      spawnFn: spawnFn as never,
      onFinished,
    });
    const started = service.start(here, plan, 'civitai-key');
    const done = await settle(service, started.id);
    expect(done).toMatchObject({ state: 'done', received: 20, folder: 'checkpoints', filename: 'p.safetensors' });
    const [python, args, options] = spawnFn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(python).toBe('/comfy/python');
    expect(args).toEqual(expect.arrayContaining(['--comfy-dir', '/comfy', '--model-paths', '/x.yaml', '--folder', 'checkpoints', '--sha256', 'abc']));
    expect(args.join(' ')).not.toContain('civitai-key');
    expect(options.env.CIVITAI_TOKEN).toBe('civitai-key');
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ state: 'done' }), plan, here);
  });

  it('starts and follows a download on another machine through the add-on', async () => {
    let polls = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/aiembodied/ping')) return json({ ok: true });
      if (target.endsWith('/aiembodied/download')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ folder: 'checkpoints', filename: 'p.safetensors', civitai_token: 'k', sha256: 'abc' });
        return json({ id: 'r1', state: 'downloading', received: 0, total: 100 });
      }
      polls += 1;
      return json(polls < 2 ? { id: 'r1', state: 'downloading', received: 50, total: 100 } : { id: 'r1', state: 'done', received: 100, total: 100 });
    }) as unknown as typeof fetch;
    const service = new ModelDownloadService({ script: '', resolveInstallation: vi.fn(), fetchFn, pollMs: 1 });
    expect(await service.hasAddon(rack)).toBe(true);
    const started = service.start(rack, plan, 'k');
    expect(await settle(service, started.id)).toMatchObject({ state: 'done', received: 100, serverName: 'Rack' });
  });

  it('says how to install the add-on when the other machine has none, and refuses a second copy', async () => {
    const fetchFn = vi.fn(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
    const service = new ModelDownloadService({ script: '', resolveInstallation: vi.fn(), fetchFn, pollMs: 1 });
    expect(await service.hasAddon(rack)).toBe(false);
    const started = service.start(rack, plan, undefined);
    expect((await settle(service, started.id)).error).toContain('custom_nodes');

    const slow = new ModelDownloadService({
      script: '',
      resolveInstallation: () => new Promise(() => undefined),
    });
    slow.start(here, plan, undefined);
    expect(() => slow.start(here, plan, undefined)).toThrow('already downloading');
  });
});

describe('model lists from another machine', () => {
  it('uses the add-on’s descriptions when it has one', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/aiembodied/models')
        ? json([{ folder: 'checkpoints', name: 'ponyRealism.safetensors', kind: 'sdxl', embeddedVae: true, embeddedClip: true, embeddedClip2: true }])
        : json([]),
    ) as unknown as typeof fetch;
    const files = await createRemoteComfyModelScanner('http://rack:8188', fetchFn)();
    expect(files).toEqual([expect.objectContaining({ name: 'ponyRealism.safetensors', kind: 'sdxl' })]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('the ComfyUI add-on’s Python', () => {
  it('passes its unit tests (downloader and model kinds)', async () => {
    const tests = path.resolve('assets/avatar-generation/comfyui-aiembodied/tests');
    const { stderr } = await promisify(execFile)(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-m', 'unittest', 'discover', '-s', tests],
      { windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(stderr).toMatch(/\nOK/);
  }, 30_000);
});
