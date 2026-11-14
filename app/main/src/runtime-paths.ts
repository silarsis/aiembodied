import { existsSync } from 'node:fs';
import path from 'node:path';

export interface RuntimePathResolution {
  path: string;
  attempted: string[];
  usedIndex: number;
}

export class RuntimeResourceNotFoundError extends Error {
  public readonly attempted: string[];

  constructor(message: string, attempted: string[]) {
    super(message);
    this.name = 'RuntimeResourceNotFoundError';
    this.attempted = attempted;
  }
}

function dedupeCandidates(candidates: string[]): string[] {
  return Array.from(new Set(candidates.map((candidate) => path.normalize(candidate))));
}

export function resolvePreloadScriptPath(baseDir: string): RuntimePathResolution {
  const candidates = dedupeCandidates([
    // Prefer ESM build (Electron supports ESM preloads directly)
    path.resolve(baseDir, 'preload.js'),
    path.resolve(baseDir, '../dist/preload.js'),
  ]);

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (existsSync(candidate)) {
      return { path: candidate, attempted: candidates, usedIndex: index };
    }
  }

  throw new RuntimeResourceNotFoundError(
    `Unable to locate preload bundle. Checked: ${candidates.join(', ')}`,
    candidates,
  );
}

export function resolveRendererEntryPoint(baseDir: string): RuntimePathResolution {
  const candidates = dedupeCandidates([
    path.resolve(baseDir, '../../renderer/dist/index.html'),
    path.resolve(baseDir, '../renderer/dist/index.html'),
  ]);

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (existsSync(candidate)) {
      return { path: candidate, attempted: candidates, usedIndex: index };
    }
  }

  throw new RuntimeResourceNotFoundError(
    `Unable to locate renderer bundle. Checked: ${candidates.join(', ')}`,
    candidates,
  );
}

/**
 * The folder with the renderer build (index.html), for serving the app to a browser at `/app/`. The same build the
 * window loads. Null when there is none (the renderer was not built), and `/app/` then says so.
 */
export function webRootFor(baseDir: string): string | null {
  try {
    return path.dirname(resolveRendererEntryPoint(baseDir).path);
  } catch {
    return null;
  }
}
