import { execFile } from 'node:child_process';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readGlb } from '../vrm-retexture.js';
import { inspectTemplateCompatibility } from '../template-compatibility.js';
import type { AvatarGenerationWarning } from '../../types.js';

/** Blender can report a Python exception while still returning process exit code zero. */
function pythonFailure(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .reverse()
    .map((line) => line.trim())
    .find((line) => /^[\w.]*(?:Error|Exception):\s/.test(line))
    ?.replace(/^[\w.]*(?:Error|Exception):\s*/, '')
    .slice(0, 500);
}

export interface FrontCheck {
  backgroundOk: boolean;
  figures: number | null;
}

export interface CharacterRigRunner {
  assertAvailable(): Promise<void>;
  inspectReference?(landmarksPath: string): Promise<AvatarGenerationWarning[]>;
  prepareReference?(input: {
    referencePath: string;
    outputPath: string;
    signal: AbortSignal;
  }): Promise<string>;
  /** Cut the character out of the image onto plain white. */
  removeBackground?(input: { imagePath: string; outputPath: string; signal: AbortSignal }): Promise<void>;
  /**
   * Quick checks on a front image: whether its background is light and neutral enough to find
   * the figure, and how many characters stand side by side (null when the background isn't).
   */
  checkFront?(input: { imagePath: string; signal: AbortSignal }): Promise<FrontCheck>;
  /**
   * Paint the front, left-side and back images onto an untextured mesh (Hunyuan3D), writing a
   * textured GLB for build(). Views that are missing are left out.
   */
  paintViews?(input: {
    meshPath: string;
    outputPath: string;
    front: string;
    left?: string;
    back?: string;
    signal: AbortSignal;
  }): Promise<void>;
  build(input: {
    landmarksPath?: string;
    allowTemplateWarnings?: boolean;
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
  inspectReference(landmarksPath: string): Promise<AvatarGenerationWarning[]> {
    return inspectTemplateCompatibility(landmarksPath);
  }
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

  async removeBackground(input: { imagePath: string; outputPath: string; signal: AbortSignal }): Promise<void> {
    if (!this.facePython) await this.assertAvailable();
    const faceRoot = path.resolve(this.env.AVATAR_FACE_DIR || 'services/avatar-face');
    await promisify(execFile)(
      this.facePython,
      [path.join(path.dirname(this.scriptPath), 'remove-background.py'), '--image', input.imagePath, '--output', input.outputPath],
      {
        windowsHide: true,
        signal: input.signal,
        timeout: 5 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
        // rembg keeps its model here; setup downloads it so this runs offline.
        env: { ...this.env, U2NET_HOME: this.env.U2NET_HOME || path.join(faceRoot, 'models', 'rembg') },
      },
    ).catch((error: unknown) => {
      if (input.signal.aborted) throw new Error('Cancelled.');
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      const reason =
        stderr.match(/BACKGROUND_ERROR: ([^\r\n]+)/)?.[1] ?? (error instanceof Error ? error.message : 'Background removal failed.');
      throw new Error(`The background could not be removed: ${reason}`);
    });
  }

  async checkFront(input: { imagePath: string; signal: AbortSignal }): Promise<FrontCheck> {
    if (!this.facePython) await this.assertAvailable();
    const { stdout } = await promisify(execFile)(
      this.facePython,
      [path.join(path.dirname(this.scriptPath), 'check-front.py'), '--image', input.imagePath],
      { windowsHide: true, signal: input.signal, timeout: 60_000, maxBuffer: 1024 * 1024, env: this.env },
    ).catch((error: unknown) => {
      if (input.signal.aborted) throw new Error('Cancelled.');
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      const reason =
        stderr.match(/FRONT_CHECK_ERROR: ([^\r\n]+)/)?.[1] ?? (error instanceof Error ? error.message : 'The check failed.');
      throw new Error(`The front image could not be checked: ${reason}`);
    });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as Partial<FrontCheck>;
    return {
      backgroundOk: result.backgroundOk === true,
      figures: typeof result.figures === 'number' ? result.figures : null,
    };
  }

  async paintViews(input: {
    meshPath: string;
    outputPath: string;
    front: string;
    left?: string;
    back?: string;
    signal: AbortSignal;
  }): Promise<void> {
    if (!this.executable) await this.assertAvailable();
    const executable = this.executable;
    if (!executable) throw new Error('Blender is unavailable.');
    await rm(input.outputPath, { force: true });
    const logPath = path.join(path.dirname(input.outputPath), 'paint-views.log');
    let output = '';
    try {
      const result = await promisify(execFile)(
        executable,
        [
          '-b',
          '--factory-startup',
          '-t',
          '4',
          '-P',
          path.join(path.dirname(this.scriptPath), 'paint-views.py'),
          '--',
          '--input',
          input.meshPath,
          '--output',
          input.outputPath,
          '--front',
          input.front,
          ...(input.left ? ['--left', input.left] : []),
          ...(input.back ? ['--back', input.back] : []),
        ],
        { windowsHide: true, signal: input.signal, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, env: this.env },
      );
      output = [result.stdout ?? '', result.stderr ?? ''].join('\n');
    } catch (error) {
      if (input.signal.aborted) throw new Error('Cancelled.');
      if (error && typeof error === 'object')
        output = ['stdout' in error ? String(error.stdout) : '', 'stderr' in error ? String(error.stderr) : ''].join('\n');
      await writeFile(logPath, output, 'utf8').catch(() => undefined);
      throw new Error(`The views could not be painted onto the model: ${pythonFailure(output) ?? (error instanceof Error ? error.message : String(error))}`);
    }
    await writeFile(logPath, output, 'utf8').catch(() => undefined);
    const failure = pythonFailure(output);
    if (failure) throw new Error(`The views could not be painted onto the model: ${failure}`);
    await access(input.outputPath).catch(() => {
      throw new Error(`Blender did not write the painted model. Check ${logPath}.`);
    });
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
    allowTemplateWarnings?: boolean;
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
    const logPath = path.join(path.dirname(input.outputPath), 'blender.log');
    let blenderOutput = '';
    try {
      const landmarks = input.landmarksPath ?? (await this.prepareReference(input));
      const result = await promisify(execFile)(
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
          ...(input.allowTemplateWarnings === true ? ['--allow-template-warnings'] : []),
        ],
        {
          windowsHide: true,
          signal: input.signal,
          timeout: 5 * 60_000,
          maxBuffer: 2 * 1024 * 1024,
          env: this.env,
        },
      ).catch(async (error: unknown) => {
        if (error && typeof error === 'object') {
          blenderOutput = [
            'stdout' in error ? String(error.stdout) : '',
            'stderr' in error ? String(error.stderr) : '',
          ].join('\n');
          await writeFile(logPath, blenderOutput, 'utf8').catch(() => undefined);
        }
        throw error;
      });
      blenderOutput = [result.stdout ?? '', result.stderr ?? ''].join('\n');
      await writeFile(logPath, blenderOutput, 'utf8');
      const failure = pythonFailure(blenderOutput);
      if (failure) throw new Error(failure);
    } catch (error) {
      if (input.signal.aborted) throw new Error('Cancelled.');
      const detail =
        pythonFailure(blenderOutput) ??
        (error && typeof error === 'object' && 'stderr' in error
          ? String(error.stderr).slice(-1500)
          : String(error));
      throw new Error(`The generated model could not be rigged: ${detail}`);
    }
    // Blender can exit successfully after a Python error. A validated output is the success signal.
    const bytes = await readFile(input.outputPath).catch(() => {
      throw new Error(
        `Blender did not produce a character. Check ${logPath} for the actual rigging error.`,
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
