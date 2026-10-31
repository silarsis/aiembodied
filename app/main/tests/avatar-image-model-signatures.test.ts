import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('weight architecture detection', () => {
  it('classifies renamed model and supporting weights without loading model data', async () => {
    const script = path.resolve('assets/avatar-generation/image-models.py');
    const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('image_models',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
headers=[
{'img_in.weight':{},'txt_in.text_norm.weight':{},'transformer_blocks.0.img_mlp.gate_up.weight_scale':{}},
{'model.diffusion_model.x.attn2.to_k.weight':{'shape':[640,2048]}},
{'model.diffusion_model.x.attn2.to_k.weight':{'shape':[320,768]}},
{'model.visual.patch_embed.proj.weight':{},'model.norm.weight':{'shape':[4096]}},
{'decoder.conv_in.weight':{'shape':[512,16,3,3]},'decoder.conv_out.weight':{}},
{'cap_embedder.1.weight':{'shape':[3840,2560]},'noise_refiner.0.attention.k_norm.weight':{}},
{'unknown.weight':{}}
]
print(json.dumps([m.signature(h,'renamed-turbo.safetensors')['kind'] for h in headers]))`;
    const { stdout } = await promisify(execFile)(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-c', code, script],
      { windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(JSON.parse(stdout)).toEqual([
      'qwen-image-2.1',
      'sdxl',
      'sd1',
      'qwen3-vl',
      'flux-ae',
      'z-image-turbo',
      null,
    ]);
  });
});
