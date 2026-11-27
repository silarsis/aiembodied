import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AicontrollerBridge } from '../src/aicontroller/bridge.js';
import { RemoteDownloads } from '../src/aicontroller/remote-downloads.js';
import { ComfyUIClient, type ComfyGraph } from '../src/avatar/generation/comfyui-client.js';
import { graphModelFiles, graphsModelFiles } from '../src/avatar/generation/comfyui-needs.js';
import { buildImageWorkflow } from '../src/avatar/generation/image-workflows.js';
import { characterMeshGraph } from '../src/avatar/generation/character/graphs.js';
import {
  createControllerModelScanner,
  type ImageModelFile,
} from '../src/avatar/generation/image-model-service.js';
import { AvatarImageModelService } from '../src/avatar/generation/image-model-service.js';
import { FAKE_BACKEND_URLS, FakeAicontroller } from './helpers/fake-aicontroller.js';

const logger = { info: vi.fn(), warn: vi.fn() };
const ACRASIA_URL = 'http://acrasia:8188';

const graph = (): ComfyGraph => ({
  ckpt: {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sdxl/juggernaut.safetensors' },
  },
  unet: {
    class_type: 'UNETLoader',
    inputs: { unet_name: 'qwen.safetensors', weight_dtype: 'default' },
  },
  clip: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl.safetensors', type: 'qwen' } },
  vae: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_vae.safetensors' } },
  lora: {
    class_type: 'LoraLoader',
    inputs: { lora_name: 'style.safetensors', strength_model: 0.8 },
  },
  net: { class_type: 'ControlNetLoader', inputs: { control_net_name: 'openpose.safetensors' } },
  sampler: {
    class_type: 'KSampler',
    inputs: { sampler_name: 'euler', scheduler: 'normal', seed: 1 },
  },
  load: { class_type: 'LoadImage', inputs: { image: 'aiembodied/front.png' } },
});

describe('model files a graph loads', () => {
  it('reads loader inputs only', () => {
    expect(graphModelFiles(graph())).toEqual([
      'openpose.safetensors',
      'qwen.safetensors',
      'qwen3vl.safetensors',
      'qwen_vae.safetensors',
      'sdxl/juggernaut.safetensors',
      'style.safetensors',
    ]);
    expect(graphsModelFiles(graph(), graph())).toHaveLength(6);
  });

  it('finds the files of the app’s own graphs', () => {
    const image = buildImageWorkflow(
      {
        id: 'x',
        name: 'x',
        family: 'qwen-image-2.1',
        model: 'q.safetensors',
        clip: 'c.safetensors',
        vae: 'v.safetensors',
      },
      'a cat',
      1,
    );
    expect(graphModelFiles(image)).toEqual(['c.safetensors', 'q.safetensors', 'v.safetensors']);
    const mesh = graphModelFiles(
      characterMeshGraph({ front: 'f.png' }, 1, {
        kind: 'trellis2',
        id: 'u',
        name: 'u',
        unet: 'u.safetensors',
        shapeVae: 's.safetensors',
        textureVae: 't.safetensors',
      }),
    );
    expect(mesh).toEqual(
      expect.arrayContaining(['s.safetensors', 't.safetensors', 'u.safetensors']),
    );
  });
});

/** A ComfyUI that records which origin each request went to. */
function fakeComfy() {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    if (url.pathname === '/upload/image')
      return new Response(JSON.stringify({ name: 'up.png', subfolder: 'aiembodied' }));
    if (url.pathname === '/prompt') return new Response(JSON.stringify({ prompt_id: 'p1' }));
    if (url.pathname.startsWith('/history/')) {
      return new Response(
        JSON.stringify({
          p1: {
            status: { completed: true },
            outputs: { 9: { images: [{ type: 'output', filename: 'a.png' }] } },
          },
        }),
      );
    }
    if (url.pathname === '/view') return new Response(new Uint8Array([1]));
    return new Response('{}');
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('leases routed by what a job loads', () => {
  let fake: FakeAicontroller;
  beforeEach(async () => {
    fake = await new FakeAicontroller().start();
    fake.peers.set('acrasia', {
      files: new Set([
        'qwen.safetensors',
        'qwen3vl.safetensors',
        'qwen_vae.safetensors',
        'juggernaut.safetensors',
        'style.safetensors',
        'openpose.safetensors',
      ]),
      online: true,
      url: ACRASIA_URL,
    });
    fake.hostModels.push(
      {
        host: 'acrasia',
        state: 'installed',
        kind: 'comfyui',
        subfolder: 'diffusion_models',
        file_name: 'qwen.safetensors',
      },
      {
        host: 'acrasia',
        state: 'installed',
        kind: 'comfyui',
        subfolder: 'text_encoders',
        file_name: 'qwen3vl.safetensors',
      },
      {
        host: 'acrasia',
        state: 'installed',
        kind: 'comfyui',
        subfolder: 'vae',
        file_name: 'qwen_vae.safetensors',
      },
      {
        host: 'acrasia',
        state: 'installed',
        kind: 'comfyui',
        subfolder: 'checkpoints',
        file_name: 'juggernaut.safetensors',
      },
      {
        host: 'acrasia',
        state: 'installed',
        kind: 'comfyui',
        subfolder: 'loras',
        file_name: 'style.safetensors',
      },
      {
        host: 'acrasia',
        state: 'installed',
        kind: 'comfyui',
        subfolder: 'controlnet',
        file_name: 'openpose.safetensors',
      },
    );
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const bridge = () =>
    new AicontrollerBridge({
      logger,
      env: { AICONTROLLER_URL: fake.url },
      watchMs: 0,
      sharedIdleMs: 120,
    });
  const client = (b: AicontrollerBridge, comfy: ReturnType<typeof fakeComfy>) =>
    new ComfyUIClient({
      baseUrl: 'http://127.0.0.1:8188',
      fetchFn: comfy.fetchFn,
      lease: {
        acquire: async (needs) => {
          const handle = await b.acquire('comfyui', { needs });
          if (!handle) throw new Error('no comfyui');
          return handle;
        },
      },
    });

  it('sends the needs to the controller and runs on the machine it chose, without releasing Echo', async () => {
    const b = bridge();
    await b.start();
    await b.ensureEcho();
    expect(fake.active('echo-llm')).toHaveLength(1);
    const comfy = fakeComfy();
    await client(b, comfy).run(graph());

    const request = fake.leaseRequests.find((entry) => entry.backend === 'comfyui');
    expect(request?.needs).toEqual(graphModelFiles(graph()));
    const lease = fake.active('comfyui')[0];
    expect(lease?.id).toMatch(/^acrasia:/);
    expect(comfy.calls).toContain(`POST ${ACRASIA_URL}/prompt`);
    expect(comfy.calls.every((entry) => entry.includes(ACRASIA_URL))).toBe(true);
    // The job doesn't use this PC's GPU, so Echo's model stays leased the whole time.
    expect(fake.active('echo-llm')).toHaveLength(1);
    expect(fake.leases.size).toBe(2);
    expect([...fake.leases.values()].filter((entry) => entry.backend === 'echo-llm')).toHaveLength(
      1,
    );
    await b.shutdown();
  });

  it('still gives Echo’s lease up for a job that stays on this PC', async () => {
    const b = bridge();
    await b.start();
    await b.ensureEcho();
    const comfy = fakeComfy();
    fake.peers.get('acrasia')!.online = false;
    fake.hostModels.length = 0;
    await client(b, comfy).run(graph());
    expect(fake.active('comfyui')[0]?.id).not.toContain(':');
    expect(comfy.calls.every((entry) => entry.includes(FAKE_BACKEND_URLS.comfyui as string))).toBe(
      true,
    );
    expect(fake.active('echo-llm')).toHaveLength(0);
    await vi.waitFor(() => expect(fake.active('echo-llm')).toHaveLength(1));
    await b.shutdown();
  });

  it('keeps a lease per set of needs: this PC’s lease is not reused for a job that routes away, nor the reverse', async () => {
    const b = bridge();
    await b.start();
    const comfy = fakeComfy();
    const c = client(b, comfy);
    await c.run({}); // no needs: this PC
    await c.run(graph()); // needs: acrasia
    await c.run({});
    await c.run(graph());
    const requests = fake.leaseRequests.filter((entry) => entry.backend === 'comfyui');
    expect(requests.map((entry) => entry.needs.length > 0)).toEqual([false, true]);
    // Two runs went to acrasia and two stayed here: three requests each (queue, history, view).
    expect(comfy.calls.filter((entry) => entry.includes(ACRASIA_URL))).toHaveLength(6);
    expect(
      comfy.calls.filter((entry) => entry.includes(FAKE_BACKEND_URLS.comfyui as string)),
    ).toHaveLength(6);
    await vi.waitFor(() => expect(fake.active('comfyui')).toHaveLength(0));
    await b.shutdown();
  });

  it('uploads and runs a job on the same lease and host', async () => {
    const b = bridge();
    await b.start();
    const comfy = fakeComfy();
    const c = client(b, comfy);
    const name = await c.job(graphModelFiles(graph()), async () => {
      const uploaded = await c.uploadImage('front.png', Buffer.from([1]));
      await c.run(graph());
      return uploaded;
    });
    expect(name).toBe('aiembodied/up.png');
    expect(fake.leaseRequests.filter((entry) => entry.backend === 'comfyui')).toHaveLength(1);
    expect(comfy.calls).toEqual(
      expect.arrayContaining([`POST ${ACRASIA_URL}/upload/image`, `POST ${ACRASIA_URL}/prompt`]),
    );
    expect(comfy.calls.every((entry) => entry.includes(ACRASIA_URL))).toBe(true);
    await b.shutdown();
  });

  it('lists models of every machine, labelled by host and de-duplicated by file name', async () => {
    fake.hostModels.push(
      {
        host: 'bija',
        state: 'installed',
        kind: 'comfyui',
        subfolder: 'diffusion_models',
        file_name: 'qwen_image_2.1_int8_convrot.safetensors',
      },
      {
        host: 'acrasia',
        state: 'offline',
        kind: 'comfyui',
        subfolder: 'diffusion_models',
        file_name: 'qwen_image_2.1_int8_convrot.safetensors',
      },
      {
        host: 'acrasia',
        state: 'busy',
        kind: 'comfyui',
        subfolder: 'loras',
        file_name: 'busy-lora.safetensors',
      },
    );
    const b = bridge();
    await b.start();
    const scan = createControllerModelScanner(
      async () =>
        (await b.listAllModels()).map((m) => ({
          kind: m.kind,
          subfolder: m.subfolder,
          fileName: m.fileName,
          host: m.host,
          state: m.state,
        })),
      async (): Promise<ImageModelFile[]> => [
        {
          folder: 'diffusion_models',
          name: 'qwen_image_2.1_int8_convrot.safetensors',
          kind: 'qwen-image-2.1',
        },
      ],
    );
    const files = await scan();
    const qwen = files.filter((file) => file.name === 'qwen_image_2.1_int8_convrot.safetensors');
    expect(qwen).toHaveLength(1);
    expect(qwen[0].hosts?.map((h) => h.name).sort()).toEqual(['acrasia', 'bija']);

    const service = new AvatarImageModelService(async () => files);
    const list = await service.list();
    const model = list.models.find(
      (entry) => entry.id === 'diffusion_models:qwen_image_2.1_int8_convrot.safetensors',
    );
    expect(model?.location).toBe('on bija, acrasia');
    expect(model?.offline).toBeUndefined();
    expect(list.loras?.find((lora) => lora.name === 'busy-lora.safetensors')).toMatchObject({
      location: 'on acrasia',
      offline: true,
    });
    await b.shutdown();
  });

  it('downloads to a machine through the controller and follows its progress', async () => {
    const b = bridge();
    await b.start();
    expect(await b.hostNames()).toEqual({ local: 'fake', hosts: ['acrasia'] });
    const remote = new RemoteDownloads(b);
    const started = await remote.startHuggingFace('acrasia', 'owner/repo-GGUF', {
      id: 'Q4/model',
      label: 'Q4_K_M',
      sizeBytes: 1000,
      files: [
        { path: 'Q4/model-00001-of-00002.gguf', size: 500 },
        { path: 'Q4/model-00002-of-00002.gguf', size: 500 },
      ],
    });
    expect(fake.downloadRequests[0]).toMatchObject({
      host: 'acrasia',
      kind: 'llm',
      source: {
        type: 'huggingface',
        repo: 'owner/repo-GGUF',
        file: 'Q4/model-00001-of-00002.gguf',
      },
    });
    expect(started.id).toBe('ctl:acrasia:D1');

    fake.downloads.get('acrasia:D1')!.bytes_done = 400;
    expect((await remote.listLlm())[0]).toMatchObject({
      state: 'downloading',
      received: 400,
      total: 1000,
    });
    fake.downloads.get('acrasia:D1')!.state = 'done';
    expect((await remote.listLlm())[0]).toMatchObject({
      state: 'done',
      result: 'Downloaded to acrasia.',
    });

    await remote.startHuggingFace('auto', 'owner/repo-GGUF', {
      id: 'a',
      label: 'Q8',
      sizeBytes: 1,
      files: [{ path: 'a.gguf', size: 1 }],
    });
    expect(fake.downloadRequests[1]).toMatchObject({ host: 'auto' });
    await b.shutdown();
  });
});
