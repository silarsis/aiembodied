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
  /** Command run in the fresh worktree before pi starts (installs dependencies). Unset: the runner picks one from the lockfile. */
  setup?: string;
  /** Extra paths (relative to the repository) that a task may not change. */
  protectedPaths?: string[];
}

export interface CodingConfig {
  /** The id of the model server (type coder) that takes the tasks. */
  runner: string;
  workspaces: CodingWorkspace[];
  /** The Qwen3-Coder-Next GGUF to run. Empty: look for one (gguf-finder.ts). */
  coderGguf?: string;
  /**
   * 'auto' (default): load the coder next to Echo's model if it fits; otherwise wait for a quiet moment and swap.
   * 'side-by-side': keep Echo's model running and load the coder next to it.
   * 'swap': stop Echo's model while the coder runs, for PCs that can't hold both.
   */
  coderMemory?: 'auto' | 'side-by-side' | 'swap';
}

/** Context size (tokens) the coder's llama-server runs with; also sent to the runner so pi's model config matches. */
export const CODER_CONTEXT_LENGTH = 65536;

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
