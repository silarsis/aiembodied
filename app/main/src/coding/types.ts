/** Coding settings types and constants with no Node imports, so the renderer can use them too. */
import { BUILT_IN_SERVER_IDS } from '../config/model-routing.js';

export type WorkspaceKind = 'project' | 'self';

export interface CodingWorkspace {
  id: string;
  name: string;
  path: string;
  /** 'self' is this app's own code: the runner protects the files that keep the coder itself safe. */
  kind: WorkspaceKind;
  baseBranch: string;
  /** Command the runner runs in the worktree before review, such as "pnpm test". */
  checks?: string;
  /** Extra paths (relative to the repository) that a task may not change. */
  protectedPaths?: string[];
}

export interface CodingConfig {
  /** The id of the model server (type coder) that takes the tasks. */
  runner: string;
  workspaces: CodingWorkspace[];
  /** The Qwen3-Coder-Next GGUF to run. Empty: look for one (gguf-finder.ts). */
  coderGguf?: string;
}

/** Paths a task in a 'self' workspace may never change. Mirrors SELF_PROTECTED in services/coder. */
export const SELF_PROTECTED_PATHS: readonly string[] = [
  'services/coder/',
  'app/main/src/coding/',
  'app/main/src/tools/tool-registry.ts',
  'app/main/src/crash-guard.ts',
];

export const DEFAULT_CODING_CONFIG: CodingConfig = { runner: BUILT_IN_SERVER_IDS.coderRunner, workspaces: [] };

export const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function slugifyWorkspaceId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug || 'workspace';
}
