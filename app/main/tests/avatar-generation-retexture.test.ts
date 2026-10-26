import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  assembleRetexturedVrm,
  getImageBytes,
  layoutSimilarity,
  prepareRegions,
  readGlb,
  regionPrompt,
  writeGlb,
  type RetextureRegion,
} from '../src/avatar/generation/vrm-retexture.js';

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data.set(rgba, index);
  }
  return PNG.sync.write(png);
}

/** A tiny VRoid-shaped VRM: one vertex bufferView plus main and shade atlas images. */
function buildVrm(): Buffer {
  const vertices = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const main = new PNG({ width: 8, height: 8 });
  for (let index = 0; index < main.data.length; index += 4) {
    const pixel = index / 4;
    // left half painted (opaque grey), right half transparent
    main.data.set(pixel % 8 < 4 ? [100, 100, 100, 255] : [0, 0, 0, 0], index);
  }
  const mainPng = PNG.sync.write(main);
  const shadePng = solidPng(8, 8, [50, 50, 50, 255]);
  const pad = (buffer: Buffer) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4)]);
  const bin = Buffer.concat([pad(vertices), pad(mainPng), shadePng]);
  const mainOffset = pad(vertices).length;
  const shadeOffset = mainOffset + pad(mainPng).length;
  return writeGlb({
    json: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: vertices.length },
        { buffer: 0, byteOffset: mainOffset, byteLength: mainPng.length },
        { buffer: 0, byteOffset: shadeOffset, byteLength: shadePng.length },
      ],
      images: [
        { bufferView: 1, mimeType: 'image/png' },
        { bufferView: 2, mimeType: 'image/png' },
      ],
      textures: [{ source: 0 }, { source: 1 }],
      extensions: {
        VRM: {
          meta: { title: 'Base' },
          materialProperties: [
            { name: 'N00_000_00_Body_00_SKIN (Instance)', textureProperties: { _MainTex: 0, _ShadeTexture: 1 } },
          ],
        },
      },
    },
    bin,
  });
}

const WHOLE_ATLAS: RetextureRegion[] = [{ name: 'all', box: [0, 0, 1, 1], prompt: 'repaint' }];

describe('vrm retexture', () => {
  it('crops regions flattened onto grey', () => {
    const [region] = prepareRegions(buildVrm(), WHOLE_ATLAS);
    expect(region.box).toEqual({ x: 0, y: 0, width: 8, height: 8 });
    const crop = PNG.sync.read(region.png);
    expect([...crop.data.subarray(0, 4)]).toEqual([100, 100, 100, 255]);
    // transparent texels become mid grey
    expect([...crop.data.subarray(4 * 4, 4 * 4 + 4)]).toEqual([128, 128, 128, 255]);
  });

  it('pastes edits through the original alpha, rebuilds shade, and keeps other buffers', () => {
    const vrm = buildVrm();
    const edited = [{ box: { x: 0, y: 0, width: 8, height: 8 }, png: solidPng(4, 4, [200, 20, 20, 255]) }];
    const result = readGlb(assembleRetexturedVrm(vrm, edited, 'Red'));

    expect(result.json.extensions?.VRM?.meta?.title).toBe('Red');
    expect([...getVertexBytes(result)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const main = PNG.sync.read(getImageBytes(result, 0));
    expect([...main.data.subarray(0, 4)]).toEqual([200, 20, 20, 255]);
    // transparent texels keep their alpha
    expect(main.data[4 * 4 + 3]).toBe(0);

    const shade = PNG.sync.read(getImageBytes(result, 1));
    // old ratio was (50+1)/(100+1) ≈ 0.505
    expect(shade.data[0]).toBe(Math.round(200 * (51 / 101)));
    expect(shade.data[1]).toBe(Math.round(20 * (51 / 101)));
  });

  it('scores a recolour as keeping the layout and a different picture as not', () => {
    const stripes = (light: [number, number, number], dark: [number, number, number]) => {
      const png = new PNG({ width: 128, height: 128 });
      for (let index = 0; index < png.data.length; index += 4) {
        const col = (index / 4) % 128;
        png.data.set([...(Math.floor(col / 16) % 2 ? dark : light), 255], index);
      }
      return PNG.sync.write(png);
    };
    const blob = new PNG({ width: 128, height: 128 });
    for (let index = 0; index < blob.data.length; index += 4) {
      const col = (index / 4) % 128;
      const row = Math.floor(index / 4 / 128);
      const inside = (col - 64) ** 2 + (row - 64) ** 2 < 30 ** 2;
      blob.data.set(inside ? [240, 240, 240, 255] : [128, 128, 128, 255], index);
    }

    const original = stripes([120, 80, 60], [60, 40, 30]);
    expect(layoutSimilarity(original, stripes([40, 200, 190], [10, 90, 90]))).toBeGreaterThan(0.9);
    expect(layoutSimilarity(original, PNG.sync.write(blob))).toBeLessThan(0.3);
    expect(layoutSimilarity(original, solidPng(128, 128, [128, 128, 128, 255]))).toBe(0);
  });

  it('ignores whatever the repaint puts in the unpainted background', () => {
    // left half: striped panel; right half: flat grey background as prepareRegions leaves it
    const panel = (background: (row: number, col: number) => number[]) => {
      const png = new PNG({ width: 128, height: 128 });
      for (let index = 0; index < png.data.length; index += 4) {
        const col = (index / 4) % 128;
        const row = Math.floor(index / 4 / 128);
        const pixel = col < 64 ? (Math.floor(row / 16) % 2 ? [200, 60, 60] : [90, 20, 20]) : background(row, col);
        png.data.set([...pixel, 255], index);
      }
      return PNG.sync.write(png);
    };
    const original = panel(() => [128, 128, 128]);
    const noisyBackground = panel((row, col) => ((row * 7 + col * 13) % 5 < 2 ? [0, 0, 0] : [255, 255, 255]));
    expect(layoutSimilarity(original, noisyBackground)).toBeGreaterThan(0.9);
  });

  it('fills region prompts with a single-line description', () => {
    expect(regionPrompt('Recolour to "{description}".', '  Teal hair,\n a "cool" hoodie ')).toBe(
      `Recolour to "Teal hair, a 'cool' hoodie".`,
    );
  });

  it('rejects models without a VRoid atlas', () => {
    const glb = readGlb(buildVrm());
    glb.json.extensions = { VRM: { materialProperties: [] } };
    expect(() => prepareRegions(writeGlb(glb), WHOLE_ATLAS)).toThrow(/not a VRoid model/);
  });
});

function getVertexBytes(glb: ReturnType<typeof readGlb>): Buffer {
  const view = glb.json.bufferViews[0];
  return glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}
