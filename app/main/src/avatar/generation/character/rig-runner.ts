import { execFile } from 'node:child_process';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readGlb } from '../vrm-retexture.js';

export interface CharacterRigRunner {
  assertAvailable(): Promise<void>;
  prepareReference?(input: {
    referencePath: string;
    outputPath: string;
    signal: AbortSignal;
  }): Promise<string>;
  build(input: {
    landmarksPath?: string;
    meshPath: string;
    referencePath: string;
    outputPath: string;
    name: string;
    signal: AbortSignal;
  }): Promise<Buffer>;
}

export class BlenderCharacterRunner implements CharacterRigRunner {
  private executable: string | null = null;
  private facePython = '';
  private faceModel = '';
  constructor(
    private readonly scriptPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async assertAvailable(): Promise<void> {
    await access(this.scriptPath);
    const faceRoot = path.resolve(this.env.AVATAR_FACE_DIR || 'services/avatar-face');
    this.facePython =
      this.env.AVATAR_FACE_PYTHON ||
      path.join(
        faceRoot,
        '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      );
    this.faceModel =
      this.env.AVATAR_FACE_MODEL || path.join(faceRoot, 'models/face_landmarker.task');
    try {
      await Promise.all([access(this.facePython), access(this.faceModel)]);
    } catch {
      throw new Error(
        'Local face fitting needs setup. Run pnpm avatar:face:setup, or configure AVATAR_FACE_PYTHON and AVATAR_FACE_MODEL.',
      );
    }
    if (this.env.BLENDER_EXE) {
      await access(this.env.BLENDER_EXE).catch(() => {
        throw new Error('BLENDER_EXE does not point to Blender.');
      });
      this.executable = this.env.BLENDER_EXE;
      return;
    }
    const root = path.join(this.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
    const versions = await readdir(root).catch(() => [] as string[]);
    for (const name of versions
      .filter((name) => /^Blender \d/.test(name))
      .sort()
      .reverse()) {
      const file = path.join(root, name, 'blender.exe');
      try {
        await access(file);
        this.executable = file;
        return;
      } catch {
        /* Try next installation. */
      }
    }
    throw new Error('Install Blender or set BLENDER_EXE to create a new 3D avatar.');
  }

  async prepareReference(input: {
    referencePath: string;
    outputPath: string;
    signal: AbortSignal;
  }): Promise<string> {
    if (!this.executable) await this.assertAvailable();
    const landmarks = path.join(path.dirname(input.outputPath), 'face-landmarks.json');
    await promisify(execFile)(
      this.facePython,
      [
        path.join(path.dirname(this.scriptPath), 'face-landmarks.py'),
        '--image',
        input.referencePath,
        '--model',
        this.faceModel,
        '--output',
        landmarks,
      ],
      {
        windowsHide: true,
        signal: input.signal,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: this.env,
      },
    ).catch((error: unknown) => {
      if (input.signal.aborted) throw new Error('Cancelled.');
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      const reason =
        stderr.match(/FACE_FITTING_ERROR: ([^\r\n]+)/)?.[1] ??
        (error instanceof Error ? error.message : 'Local face detection failed.');
      throw new Error(`The reference face could not be fitted: ${reason}`);
    });
    return landmarks;
  }

  async build(input: {
    landmarksPath?: string;
    meshPath: string;
    referencePath: string;
    outputPath: string;
    name: string;
    signal: AbortSignal;
  }): Promise<Buffer> {
    if (!this.executable) await this.assertAvailable();
    const executable = this.executable;
    if (!executable) throw new Error('Blender is unavailable.');
    // A Python exception can leave Blender's process exit code at zero. Never
    // accept a candidate left over from an earlier attempt at the same path.
    await rm(input.outputPath, { force: true });
    try {
      const landmarks = input.landmarksPath ?? (await this.prepareReference(input));
      await promisify(execFile)(
        executable,
        [
          '-b',
          '--factory-startup',
          '-t',
          '4',
          '-P',
          this.scriptPath,
          '--',
          '--input',
          input.meshPath,
          '--output',
          input.outputPath,
          '--name',
          input.name,
          '--reference',
          input.referencePath,
          '--landmarks',
          landmarks,
        ],
        {
          windowsHide: true,
          signal: input.signal,
          timeout: 5 * 60_000,
          maxBuffer: 2 * 1024 * 1024,
          env: this.env,
        },
      );
    } catch (error) {
      if (input.signal.aborted) throw new Error('Cancelled.');
      const detail =
        error && typeof error === 'object' && 'stderr' in error
          ? String(error.stderr).slice(-1500)
          : String(error);
      throw new Error(`The generated model could not be rigged: ${detail}`);
    }
    // Blender can exit successfully after a Python error. A validated output is the success signal.
    const bytes = await readFile(input.outputPath).catch(() => {
      throw new Error(
        'Blender did not produce a character. Try a simple adult humanoid with separated limbs.',
      );
    });
    const doc = readGlb(bytes).json;
    const extensions = doc.extensions as Record<string, unknown> | undefined;
    const meshes = doc.meshes as Array<{ weights?: number[] }> | undefined;
    if (
      meshes?.some((mesh) =>
        mesh.weights?.some((weight) => !Number.isFinite(weight) || Math.abs(weight) > 1e-8),
      )
    ) {
      throw new Error(
        'The fitted face was exported with active expressions instead of a neutral face.',
      );
    }
    if (!extensions?.VRMC_vrm || !Array.isArray(doc.skins) || !doc.skins.length) {
      throw new Error('The generated character is missing its VRM rig.');
    }
    const vrm = extensions.VRMC_vrm as {
      expressions?: {
        preset?: Record<string, { morphTargetBinds?: unknown[] }>;
        custom?: Record<string, { morphTargetBinds?: unknown[] }>;
      };
    };
    const expressions = { ...vrm.expressions?.preset, ...vrm.expressions?.custom };
    for (const name of [
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
    ]) {
      if (!expressions[name]?.morphTargetBinds?.length)
        throw new Error(`The fitted face is missing its ${name} animation.`);
    }
    return bytes;
  }
}
