import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlenderCharacterRunner } from '../src/avatar/generation/character/rig-runner.js';
import { writeGlb } from '../src/avatar/generation/vrm-retexture.js';
import { characterConceptPrompt } from '../src/avatar/generation/character/graphs.js';

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: exec }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'face-runner-'));
  exec.mockReset();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const files = ['rig-character.py', 'python', 'face.task', 'blender'];
  await Promise.all(files.map((file) => writeFile(path.join(directory, file), 'fixture')));
  const runner = new BlenderCharacterRunner(path.join(directory, files[0]), {
    AVATAR_FACE_PYTHON: path.join(directory, 'python'),
    AVATAR_FACE_MODEL: path.join(directory, 'face.task'),
    BLENDER_EXE: path.join(directory, 'blender'),
  });
  const input = {
    meshPath: path.join(directory, 'mesh.glb'),
    referencePath: path.join(directory, 'reference.png'),
    outputPath: path.join(directory, 'avatar.vrm'),
    name: 'Fixture',
    signal: new AbortController().signal,
  };
  return { runner, input };
}
function candidate(missing?: string, defaultWeight = 0) {
  const names = [
    'aa',
    'ih',
    'ou',
    'ee',
    'oh',
    'blink',
    'happy',
    'sad',
    'angry',
    'surprised',
    'fear',
    'disgust',
  ];
  const preset = Object.fromEntries(
    names
      .filter((name) => name !== missing)
      .map((name) => [name, { morphTargetBinds: [{ node: 0, index: 0, weight: 1 }] }]),
  );
  return writeGlb({
    json: {
      buffers: [],
      bufferViews: [],
      skins: [{}],
      meshes: [{ weights: [defaultWeight] }],
      extensions: { VRMC_vrm: { expressions: { preset } } },
    } as Parameters<typeof writeGlb>[0]['json'],
    bin: Buffer.alloc(0),
  });
}
function complete(input: { outputPath: string }, bytes?: Buffer) {
  exec.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    void (async () => {
      if (String(args[0]).endsWith('blender') && bytes) await writeFile(input.outputPath, bytes);
      callback(null, '', '');
    })();
  });
}
describe('local fitted face runner', () => {
  it('uses the approved reference in a finite local detector before Blender, then validates expressions', async () => {
    const { runner, input } = await setup();
    const bytes = candidate();
    complete(input, bytes);
    expect(await runner.build(input)).toEqual(bytes);
    expect(exec.mock.calls[0][0]).toBe(path.join(directory, 'python'));
    expect(exec.mock.calls[0][1]).toContain(input.referencePath);
    expect(exec.mock.calls[0][2]).toMatchObject({
      timeout: 60_000,
      signal: input.signal,
      windowsHide: true,
    });
    expect(exec.mock.calls[1][1]).toEqual(
      expect.arrayContaining([
        '--reference',
        input.referencePath,
        '--landmarks',
        path.join(directory, 'face-landmarks.json'),
      ]),
    );
  });
  it('rejects an incomplete facial rig rather than accepting a static head', async () => {
    const { runner, input } = await setup();
    complete(input, candidate('blink'));
    await expect(runner.build(input)).rejects.toThrow('missing its blink animation');
  });
  it('does not accept a stale candidate when Blender exits zero after a Python exception', async () => {
    const { runner, input } = await setup();
    await writeFile(input.outputPath, candidate());
    complete(input);
    await expect(runner.build(input)).rejects.toThrow('did not produce a character');
    await expect(readFile(input.outputPath)).rejects.toThrow();
  });
  it('rejects nonzero exported defaults that would keep the eyes shut when expressions reset', async () => {
    const { runner, input } = await setup();
    complete(input, candidate(undefined, 1));
    await expect(runner.build(input)).rejects.toThrow(
      'active expressions instead of a neutral face',
    );
  });
  it('stops on detector failure without adding generic facial parts', async () => {
    const { runner, input } = await setup();
    exec.mockImplementation((...args: unknown[]) =>
      (args.at(-1) as (e: Error) => void)(new Error('No visible face')),
    );
    await expect(runner.build(input)).rejects.toThrow('No visible face');
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('fails preflight with a setup instruction when the local model is absent', async () => {
    const { runner } = await setup();
    await rm(path.join(directory, 'face.task'));
    await expect(runner.assertAvailable()).rejects.toThrow('pnpm avatar:face:setup');
  });
  it('asks for a visible neutral face suitable for landmark fitting', () => {
    const prompt = characterConceptPrompt('A botanist');
    expect(prompt).toContain('open eyes and closed lips');
    expect(prompt).not.toMatch(/blank|featureless|NO eyes/);
  });
});
