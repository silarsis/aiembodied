/**
 * The coding settings kept in preferences.json: which coding runner takes the tasks, the
 * repositories (workspaces) it may work in, and where the coder model's GGUF file is.
 *
 * The runner itself is services/coder; the app tells it the workspaces, keys and settings (sync.ts).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CODING_CONFIG,
  SELF_PROTECTED_PATHS,
  WORKSPACE_ID_PATTERN,
  slugifyWorkspaceId,
  type CodingConfig,
  type CodingWorkspace,
  type WorkspaceKind,
} from './types.js';

export {
  DEFAULT_CODING_CONFIG,
  SELF_PROTECTED_PATHS,
  slugifyWorkspaceId,
  type CodingConfig,
  type CodingWorkspace,
  type WorkspaceKind,
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Keep only well-formed workspaces; duplicates by id are dropped. Returns undefined when there is no coding section. */
export function sanitizeCodingConfig(input: unknown): CodingConfig | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const seen = new Set<string>();
  const workspaces: CodingWorkspace[] = [];
  for (const entry of Array.isArray(record.workspaces) ? record.workspaces : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const id = text(item.id);
    const workspacePath = text(item.path);
    if (!id || !WORKSPACE_ID_PATTERN.test(id) || seen.has(id) || !workspacePath) continue;
    seen.add(id);
    const protectedPaths = Array.isArray(item.protectedPaths)
      ? item.protectedPaths.map(text).filter((value): value is string => Boolean(value))
      : [];
    const checks = text(item.checks);
    workspaces.push({
      id,
      name: text(item.name) ?? id,
      path: workspacePath,
      kind: item.kind === 'self' ? 'self' : 'project',
      baseBranch: text(item.baseBranch) ?? 'main',
      ...(checks ? { checks } : {}),
      ...(protectedPaths.length ? { protectedPaths } : {}),
    });
  }
  const coderGguf = text(record.coderGguf);
  const coderMemory = record.coderMemory === 'swap' || record.coderMemory === 'side-by-side' ? record.coderMemory : undefined;
  return {
    runner: text(record.runner) ?? DEFAULT_CODING_CONFIG.runner,
    workspaces,
    ...(coderGguf ? { coderGguf } : {}),
    ...(coderMemory ? { coderMemory } : {}),
  };
}

/** The first workspace: this app's own repository, when the app runs from a git checkout. */
export function seedCodingConfig(repoRoot: string, exists: (file: string) => boolean = existsSync): CodingConfig | null {
  const root = path.resolve(repoRoot);
  if (!exists(path.join(root, '.git'))) return null;
  return {
    runner: DEFAULT_CODING_CONFIG.runner,
    workspaces: [
      { id: 'aiembodied', name: 'aiembodied', path: root, kind: 'self', baseBranch: 'main', checks: 'pnpm -w typecheck && pnpm test' },
    ],
  };
}

/** A workspace as the runner wants it (PUT /v1/workspaces). */
export function toRunnerWorkspace(workspace: CodingWorkspace): Record<string, unknown> {
  const protectedPaths =
    workspace.kind === 'self'
      ? [...new Set([...SELF_PROTECTED_PATHS, ...(workspace.protectedPaths ?? [])])]
      : workspace.protectedPaths ?? [];
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    kind: workspace.kind,
    base_branch: workspace.baseBranch,
    ...(workspace.checks ? { checks: workspace.checks } : {}),
    protected_paths: protectedPaths,
  };
}
