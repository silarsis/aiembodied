import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readGlb } from '../vrm-retexture.js';

export interface CharacterRigRunner {
  assertAvailable(): Promise<void>;
  build(input: {
    meshPath: string;
    outputPath: string;
    name: string;
    signal: AbortSignal;
  }): Promise<Buffer>;
}

export class BlenderCharacterRunner implements CharacterRigRunner {
  private executable: string | null = null;
  constructor(
    private readonly scriptPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async assertAvailable(): Promise<void> {
    await access(this.scriptPath);
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

  async build(input: {
    meshPath: string;
    outputPath: string;
    name: string;
    signal: AbortSignal;
  }): Promise<Buffer> {
    if (!this.executable) await this.assertAvailable();
    const executable = this.executable;
    if (!executable) throw new Error('Blender is unavailable.');
    try {
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
    if (!extensions?.VRMC_vrm || !Array.isArray(doc.skins) || !doc.skins.length) {
      throw new Error('The generated character is missing its VRM rig.');
    }
    return bytes;
  }
}
