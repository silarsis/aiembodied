import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectTemplateCompatibility,
  templatePolicy,
} from '../src/avatar/generation/template-compatibility.js';
import { buildAvatarImageWorkflow } from '../src/avatar/generation/image-workflows.js';

async function inspect(width: number, height: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'template-reference-'));
  try {
    const file = path.join(directory, 'landmarks.json');
    await writeFile(
      file,
      JSON.stringify({
        imageSize: [1000, 1000],
        bodyBounds: [0, 0, 1000, 1000],
        landmarks: Array.from({ length: 478 }, (_, i) => [
          i % 2 ? 0.1 + width : 0.1,
          i % 3 ? 0.05 + height : 0.05,
          0,
        ]),
      }),
    );
    return await inspectTemplateCompatibility(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
describe('avatar template compatibility', () => {
  it('warns with measured proportions for an oversized reference', async () => {
    const warnings = await inspect(0.233, 0.2);
    expect(warnings).toEqual([{ code: 'face-width', message: expect.stringContaining('23.3%') }]);
    expect(warnings[0].message).toContain('22%');
  });
  it('accepts supported proportions and warns for a tall face', async () => {
    expect(await inspect(0.15, 0.2)).toEqual([]);
    expect((await inspect(0.15, 0.4))[0].code).toBe('face-height');
    expect((await inspect(0.15, 0.28))[0].code).toBe('face-position');
    expect(templatePolicy.faceWidthMax).toBe(0.22);
  });
  it('guides all families toward the template without negative instructions to remove facial features', () => {
    for (const family of ['qwen-image-2.1', 'z-image-turbo', 'sdxl', 'sd1'] as const) {
      const graph = buildAvatarImageWorkflow(
        {
          id: 'fixture',
          name: 'Fixture',
          family,
          model: 'fixture.safetensors',
          clip: 'clip.safetensors',
          vae: 'vae.safetensors',
        },
        'A fantasy explorer',
        'new-character',
        123,
      );
      expect(JSON.stringify(graph)).toContain('1/6');
      expect(JSON.stringify(graph)).toContain('22%');
      if (family === 'sdxl' || family === 'sd1') {
        expect(graph.negative.inputs.text).not.toMatch(/\beyes\b|\beyebrows\b|\bmouth\b/);
        expect(graph.negative.inputs.text).toContain('oversized head');
      }
    }
  });
});
