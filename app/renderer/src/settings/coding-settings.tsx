/**
 * The Coding page of the Models and servers pop-up, below the Coding model picker: which runner
 * takes the tasks, the coder model file, and the workspaces (repositories) the runner may work in.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ModelServerView } from '../../../main/src/config/config-manager.js';
import type { CodingBridge, CodingConfig, CodingStatus } from '../../../main/src/coding/bridge-types.js';
import { SELF_PROTECTED_PATHS, slugifyWorkspaceId, type CodingWorkspace } from '../../../main/src/coding/types.js';
import type { ServerProbe } from '../../../main/src/config/model-server-probe.js';

export const CODING_STATUS_POLL_MS = 5000;

interface Draft {
  /** Empty for a new workspace. */
  id: string;
  name: string;
  path: string;
  kind: 'project' | 'self';
  baseBranch: string;
  checks: string;
  /** One path per line. */
  protectedPaths: string;
}

const emptyDraft = (): Draft => ({ id: '', name: '', path: '', kind: 'project', baseBranch: 'main', checks: '', protectedPaths: '' });

const toDraft = (workspace: CodingWorkspace): Draft => ({
  id: workspace.id,
  name: workspace.name,
  path: workspace.path,
  kind: workspace.kind,
  baseBranch: workspace.baseBranch,
  checks: workspace.checks ?? '',
  protectedPaths: (workspace.protectedPaths ?? []).join('\n'),
});

function fromDraft(draft: Draft, taken: string[]): CodingWorkspace {
  let id = draft.id;
  if (!id) {
    const base = slugifyWorkspaceId(draft.name || draft.path.split(/[\\/]/).filter(Boolean).pop() || 'workspace');
    id = base;
    for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  }
  const protectedPaths = draft.protectedPaths
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    id,
    name: draft.name.trim() || id,
    path: draft.path.trim(),
    kind: draft.kind,
    baseBranch: draft.baseBranch.trim() || 'main',
    ...(draft.checks.trim() ? { checks: draft.checks.trim() } : {}),
    ...(protectedPaths.length ? { protectedPaths } : {}),
  };
}

export interface CodingSettingsProps {
  api: CodingBridge;
  /** The runner servers (type coder) to pick from. */
  runners: ModelServerView[];
  runnerProbe?: ServerProbe | 'checking';
  onProbeRunner(id: string): void;
}

function coderMemoryFrom(value: string): 'auto' | 'side-by-side' | 'swap' {
  return value === 'swap' || value === 'side-by-side' ? value : 'auto';
}

export function CodingSettings({ api, runners, runnerProbe, onProbeRunner }: CodingSettingsProps) {
  const [coding, setCoding] = useState<CodingConfig | null>(null);
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const [status, setStatus] = useState<CodingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gguf, setGguf] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.get())
      .then((view) => {
        if (cancelled) return;
        setCoding(view.coding);
        setRunnerId(view.runnerId);
        setStatus(view.status);
        setGguf(view.coding.coderGguf ?? '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the coding settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.resolve()
        .then(() => api.status())
        .then(setStatus)
        .catch(() => undefined);
    }, CODING_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [api]);

  const save = useCallback(
    async (next: CodingConfig, done?: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const view = await api.set(next);
        setCoding(view.coding);
        setRunnerId(view.runnerId);
        setStatus(view.status);
        setGguf(view.coding.coderGguf ?? '');
        if (done) setNotice(done);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That change could not be saved.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  if (!coding) {
    return error ? (
      <p role="alert" className="kiosk__error">
        {error}
      </p>
    ) : (
      <p className="kiosk__helper">Loading…</p>
    );
  }

  const workspaceError = status?.workspaceError;
  const pickGguf = async () => {
    const picked = await api.pickGguf();
    if (picked) await save({ ...coding, coderGguf: picked }, 'Saved.');
  };
  const saveGguf = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === (coding.coderGguf ?? '')) return;
    void save({ ...coding, coderGguf: trimmed || undefined }, 'Saved.');
  };

  const saveDraft = async () => {
    if (!draft) return;
    const taken = coding.workspaces.map((entry) => entry.id);
    const workspace = fromDraft(draft, taken);
    const exists = coding.workspaces.some((entry) => entry.id === workspace.id);
    const workspaces = exists ? coding.workspaces.map((entry) => (entry.id === workspace.id ? workspace : entry)) : [...coding.workspaces, workspace];
    if (await save({ ...coding, workspaces }, 'Saved.')) setDraft(null);
  };

  const removeWorkspace = async (id: string) => {
    if (await save({ ...coding, workspaces: coding.workspaces.filter((entry) => entry.id !== id) }, 'Removed.')) setDraft(null);
  };

  const suggest = async () => {
    if (!draft) return;
    const workspace = fromDraft(draft, coding.workspaces.map((entry) => entry.id));
    const exists = coding.workspaces.some((entry) => entry.id === workspace.id);
    // The runner can only look at a workspace it has been told about, so save the row first.
    const workspaces = exists ? coding.workspaces.map((entry) => (entry.id === workspace.id ? workspace : entry)) : [...coding.workspaces, workspace];
    if (!(await save({ ...coding, workspaces }))) return;
    setBusy(true);
    try {
      const suggestion = await api.suggestChecks(workspace.id);
      setDraft((current) => (current ? { ...current, id: workspace.id, checks: suggestion ?? current.checks } : current));
      setNotice(suggestion ? `Suggested: ${suggestion}` : 'The runner could not suggest a checks command for this repository.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The runner did not answer.');
    } finally {
      setBusy(false);
    }
  };

  const runner = runners.find((entry) => entry.id === runnerId);
  return (
    <>
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="kiosk__info">
          {notice}
        </p>
      ) : null}

      <div className="modelsDialog__list">
        <span className="modelsDialog__group">Runner</span>
        <div className="modelsDialog__fields">
          <label htmlFor="coding-runner">Takes the tasks</label>
          <select
            id="coding-runner"
            value={runnerId ?? ''}
            disabled={busy}
            onChange={(event) => void save({ ...coding, runner: event.target.value })}
          >
            {runners.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <span />
          <span className="modelsDialog__actions">
            <span
              className={`modelsDialog__dot is-${!runnerProbe ? 'unknown' : runnerProbe === 'checking' ? 'checking' : runnerProbe.status}`}
              role="img"
              aria-label={runnerProbe && runnerProbe !== 'checking' ? (runnerProbe.status === 'up' ? 'Runner running' : 'Runner not ready') : 'Runner not checked'}
            />
            <span className="modelsDialog__state">
              {!runnerProbe ? 'Not checked yet' : runnerProbe === 'checking' ? 'Checking…' : runnerProbe.status === 'up' ? 'Running' : (runnerProbe.message ?? 'Not reachable')}
            </span>
            {runner ? (
              <button type="button" onClick={() => onProbeRunner(runner.id)} disabled={runnerProbe === 'checking'}>
                Test
              </button>
            ) : null}
          </span>
        </div>
        <p className="kiosk__helper">
          The runner (services/coder) starts with pnpm dev:run. Each task runs in its own git worktree and ends in a pull request you approve. It needs pi:
          npm install -g @earendil-works/pi-coding-agent. Add a runner on another PC under Servers.
        </p>
        {status ? <p className="kiosk__helper">Models: {status.swap.message}</p> : null}
      </div>

      <div className="modelsDialog__list">
        <span className="modelsDialog__group">Coder model file</span>
        <div className="modelsDialog__fields">
          <label htmlFor="coding-gguf">Qwen3-Coder-Next GGUF</label>
          <span className="modelsDialog__model">
            <input
              id="coding-gguf"
              value={gguf}
              placeholder={status?.detectedGguf ?? 'Path to the Q4_K_M .gguf file (the first part, if it is split)'}
              onChange={(event) => setGguf(event.target.value)}
              onBlur={() => saveGguf(gguf)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveGguf(gguf);
              }}
              disabled={busy}
            />
            <span className="modelsDialog__modelActions">
              <button type="button" onClick={() => void pickGguf()} disabled={busy}>
                Browse…
              </button>
              {status?.detectedGguf ? <small>Detected: {status.detectedGguf}</small> : <small>Nothing detected. Pick the file.</small>}
            </span>
          </span>
          <label htmlFor="coding-memory">Memory</label>
          <select
            id="coding-memory"
            value={coding.coderMemory ?? 'auto'}
            disabled={busy}
            onChange={(event) => void save({ ...coding, coderMemory: coderMemoryFrom(event.target.value) }, 'Saved.')}
          >
            <option value="auto">Auto: next to Echo’s model if it fits, otherwise wait for a quiet moment and swap</option>
            <option value="side-by-side">Run next to Echo’s model (needs memory for both)</option>
            <option value="swap">Swap: stop Echo’s model while coding (Echo chats on the coder model)</option>
          </select>
        </div>
        <p className="kiosk__helper">
          Only used when the Coding model is the built-in Qwen3-Coder-Next server. While a task runs, the app loads this model next to Echo’s chat model and stops it again when it is no longer needed. With Swap, it stops Echo’s chat model instead and puts it back when the tasks are done.
        </p>
      </div>

      <div className="modelsDialog__list">
        <span className="modelsDialog__group">Workspaces</span>
        {workspaceError ? <p className="kiosk__error">The runner refused the workspaces: {workspaceError}</p> : null}
        {coding.workspaces.length ? (
          coding.workspaces.map((workspace) => (
            <div key={workspace.id} className="modelsDialog__server">
              <div className="modelsDialog__serverText">
                <b>{workspace.name}</b>
                <code>{workspace.path}</code>
              </div>
              <small className={`modelsDialog__where ${workspace.kind === 'self' ? 'is-online' : 'is-local'}`}>{workspace.kind === 'self' ? 'Echo’s own code' : 'Project'}</small>
              <span className="modelsDialog__state">
                {workspace.baseBranch}
                {workspace.checks ? ` · ${workspace.checks}` : ''}
              </span>
              <button type="button" onClick={() => setDraft(toDraft(workspace))} disabled={busy} aria-label={`Edit ${workspace.name}`}>
                Edit
              </button>
            </div>
          ))
        ) : (
          <p className="kiosk__helper">No workspaces yet. Echo can only code in the repositories you add here.</p>
        )}
        {draft ? (
          <form
            className="modelsDialog__add"
            aria-label={draft.id ? 'Edit workspace' : 'New workspace'}
            onSubmit={(event) => {
              event.preventDefault();
              void saveDraft();
            }}
          >
            <b>{draft.id ? 'Edit workspace' : 'New workspace'}</b>
            <div className="modelsDialog__fields">
              <label htmlFor="ws-name">Name</label>
              <input id="ws-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              <label htmlFor="ws-path">Folder</label>
              <span className="modelsDialog__model">
                <input id="ws-path" value={draft.path} placeholder="C:\src\my-project" onChange={(event) => setDraft({ ...draft, path: event.target.value })} />
                <span className="modelsDialog__modelActions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void api.pickFolder().then((picked) => {
                        if (picked) setDraft((current) => (current ? { ...current, path: picked, name: current.name || picked.split(/[\\/]/).filter(Boolean).pop() || '' } : current));
                      })
                    }
                  >
                    Browse…
                  </button>
                  <small>A git repository.</small>
                </span>
              </span>
              <label htmlFor="ws-kind">Kind</label>
              <select id="ws-kind" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value === 'self' ? 'self' : 'project' })}>
                <option value="project">Project</option>
                <option value="self">Echo’s own code</option>
              </select>
              <label htmlFor="ws-branch">Base branch</label>
              <input id="ws-branch" value={draft.baseBranch} onChange={(event) => setDraft({ ...draft, baseBranch: event.target.value })} />
              <label htmlFor="ws-checks">Checks</label>
              <span className="modelsDialog__model">
                <input id="ws-checks" value={draft.checks} placeholder="pnpm test" onChange={(event) => setDraft({ ...draft, checks: event.target.value })} />
                <span className="modelsDialog__modelActions">
                  <button type="button" onClick={() => void suggest()} disabled={busy || !draft.path.trim()}>
                    Suggest
                  </button>
                  <small>Run before a task goes to review. Suggest saves the row and asks the runner.</small>
                </span>
              </span>
              <label htmlFor="ws-protected">{draft.kind === 'self' ? 'Extra protected paths' : 'Protected paths'}</label>
              <span className="modelsDialog__model">
                {draft.kind === 'self' ? (
                  <small>
                    Always protected: <code>{SELF_PROTECTED_PATHS.join(', ')}</code>
                  </small>
                ) : null}
                <textarea
                  id="ws-protected"
                  rows={3}
                  value={draft.protectedPaths}
                  placeholder="One path per line, such as migrations/"
                  onChange={(event) => setDraft({ ...draft, protectedPaths: event.target.value })}
                />
                <small>A task that changes a protected path cannot be applied.</small>
              </span>
            </div>
            <div className="modelsDialog__actions">
              <button type="submit" className="modelsDialog__primary" disabled={busy || !draft.path.trim()}>
                Save workspace
              </button>
              <button type="button" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </button>
              {draft.id ? (
                <button type="button" onClick={() => void removeWorkspace(draft.id)} disabled={busy}>
                  Remove workspace
                </button>
              ) : null}
            </div>
          </form>
        ) : (
          <div>
            <button type="button" className="modelsDialog__primary" onClick={() => setDraft(emptyDraft())} disabled={busy}>
              Add a workspace
            </button>
          </div>
        )}
      </div>
    </>
  );
}
