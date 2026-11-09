/**
 * The Coding section of the status panel: the coding agent's tasks as cards (what each is doing,
 * its questions, its review), buttons to open the diff, apply, follow up, discard and cancel, and
 * a form to start a task by hand. Live: the runner's event stream refreshes the list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodingBridge, CodingTasksBridge, RunnerTask } from '../../../main/src/coding/bridge-types.js';
import type { CodingWorkspace } from '../../../main/src/coding/types.js';
import type { LocalVoiceBridge } from '../preload-api.js';

export const CODING_TASKS_POLL_MS = 10_000;
const FINISHED = ['done', 'failed', 'cancelled', 'discarded'];
const CANCELLABLE = ['queued', 'starting', 'working', 'question', 'paused', 'checks'];
const HAS_DIFF = ['working', 'question', 'paused', 'checks', 'review', 'done', 'failed', 'cancelled'];
const MAX_FINISHED_SHOWN = 4;

export function sortTasks(tasks: RunnerTask[]): RunnerTask[] {
  const active = tasks.filter((task) => !FINISHED.includes(task.status));
  const finished = tasks.filter((task) => FINISHED.includes(task.status) && task.status !== 'discarded').slice(0, MAX_FINISHED_SHOWN);
  return [...active, ...finished];
}

export function describeStatus(task: RunnerTask): string {
  const bits = [task.status];
  if (task.current_tool) bits.push(`using ${task.current_tool}`);
  if (task.phase_detail && task.phase_detail !== task.status) bits.push(task.phase_detail);
  return bits.join(' - ');
}

export interface CodingTasksPanelProps {
  api?: CodingTasksBridge;
  codingApi?: Pick<CodingBridge, 'get'>;
  localVoice?: Pick<LocalVoiceBridge, 'systemStatus'>;
  active: boolean;
}

export function CodingTasksPanel({ api, codingApi, localVoice, active }: CodingTasksPanelProps) {
  const [tasks, setTasks] = useState<RunnerTask[] | null>(null);
  const [workspaces, setWorkspaces] = useState<CodingWorkspace[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(0);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setTasks(await api.list());
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
    try {
      const status = await localVoice?.systemStatus?.();
      setWaiting(status?.pending ?? 0);
    } catch {
      // Not shown.
    }
  }, [api, localVoice]);

  useEffect(() => {
    if (!api || !active) return undefined;
    void Promise.resolve().then(refresh);
    void Promise.resolve()
      .then(() => codingApi?.get())
      .then((view) => view && setWorkspaces(view.coding.workspaces))
      .catch(() => undefined);
    const poll = window.setInterval(() => void refresh(), CODING_TASKS_POLL_MS);
    const off = api.onEvent(() => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void refresh();
      }, 200);
    });
    return () => {
      window.clearInterval(poll);
      off();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [api, codingApi, active, refresh]);

  if (!api) return null;
  const shown = tasks ? sortTasks(tasks) : [];
  return (
    <section className="codingTasks" aria-label="Coding tasks" data-testid="coding-tasks">
      <h3 className="codingTasks__title">Coding tasks</h3>
      {waiting > 0 ? (
        <p className="kiosk__helper" data-testid="coding-waiting">
          Echo has {waiting} update{waiting === 1 ? '' : 's'} waiting to be spoken.
        </p>
      ) : null}
      {problem ? <p className="kiosk__helper">The coding runner is not answering: {problem}</p> : null}
      {tasks && shown.length === 0 && !problem ? <p className="kiosk__helper">No tasks yet.</p> : null}
      {shown.map((task) => (
        <TaskCard key={task.id} task={task} api={api} workspaces={workspaces} onChanged={() => void refresh()} />
      ))}
      <StartTaskForm api={api} workspaces={workspaces} onStarted={() => void refresh()} />
    </section>
  );
}

function TaskCard({ task, api, workspaces, onChanged }: { task: RunnerTask; api: CodingTasksBridge; workspaces: CodingWorkspace[]; onChanged: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [followUp, setFollowUp] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspace = workspaces.find((ws) => ws.id === task.workspace_id);
  const questions = task.questions ?? [];
  const review = task.review;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleDiff = async () => {
    if (diff !== null) {
      setDiff(null);
      return;
    }
    await run(async () => setDiff((await api.diff(task.id)) || '(no changes yet)'));
  };

  return (
    <article className="codingTask" data-testid="coding-task" data-status={task.status}>
      <header className="codingTask__header">
        <b className="codingTask__goal">{task.goal}</b>
        <span className="codingTask__workspace">{workspace?.name ?? task.workspace_id}</span>
      </header>
      <p className="codingTask__status">{describeStatus(task)}</p>
      {(task.files_touched?.length ?? 0) > 0 ? <p className="codingTask__meta">{task.files_touched?.length} file(s) touched</p> : null}
      {task.error ? <p className="codingTask__error">{task.error}</p> : null}
      {task.pr_url ? (
        <p className="codingTask__meta">
          Pull request: <span className="codingTask__link">{task.pr_url}</span>
        </p>
      ) : null}

      {questions.map((q) => (
        <div className="codingTask__question" key={q.id} data-testid="coding-question">
          <p>
            <b>{q.kind === 'confirm' ? 'Asks permission' : 'Asks'}:</b> {q.kind === 'confirm' ? `${q.title ?? ''} ${q.message ?? ''}`.trim() : (q.message ?? q.title)}
          </p>
          {q.kind === 'confirm' ? (
            <div className="codingTask__actions">
              <button type="button" disabled={busy} onClick={() => void run(() => api.answer(task.id, { confirmed: true, dialog_id: q.id }))}>
                Allow
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.answer(task.id, { confirmed: false, dialog_id: q.id }))}>
                Deny
              </button>
            </div>
          ) : q.kind === 'select' ? (
            <div className="codingTask__actions">
              {(q.options ?? []).map((o) => {
                const value = typeof o === 'string' ? o : String((o as { value?: unknown; label?: unknown })?.value ?? (o as { label?: unknown })?.label ?? '');
                return (
                  <button key={value} type="button" disabled={busy} onClick={() => void run(() => api.answer(task.id, { value, dialog_id: q.id }))}>
                    {value}
                  </button>
                );
              })}
            </div>
          ) : (
            <form
              className="codingTask__row"
              onSubmit={(event) => {
                event.preventDefault();
                const value = (answers[q.id] ?? '').trim();
                if (value) void run(() => api.answer(task.id, { value, dialog_id: q.id }).then(() => setAnswers((prev) => ({ ...prev, [q.id]: '' }))));
              }}
            >
              <input aria-label="Your answer" value={answers[q.id] ?? ''} onChange={(event) => setAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))} />
              <button type="submit" disabled={busy || !(answers[q.id] ?? '').trim()}>
                Answer
              </button>
            </form>
          )}
        </div>
      ))}

      {review ? (
        <div className="codingTask__review" data-testid="coding-review">
          <p>{review.summary ?? 'No summary.'}</p>
          {(review.flags ?? []).map((flag) => (
            <p className="codingTask__flag" key={flag}>
              Flag: {flag}
            </p>
          ))}
          {(review.protected_violations ?? []).map((path) => (
            <p className="codingTask__error" key={path}>
              Protected path changed: {path}
            </p>
          ))}
          {task.checks_ok === null || task.checks_ok === undefined ? (
            <p className="codingTask__meta">No checks configured.</p>
          ) : (
            <details>
              <summary className={task.checks_ok ? 'codingTask__ok' : 'codingTask__error'}>Checks {task.checks_ok ? 'passed' : 'failed'}</summary>
              <pre className="codingTask__pre">{task.checks_output || '(no output)'}</pre>
            </details>
          )}
        </div>
      ) : null}

      {diff !== null ? (
        <pre className="codingTask__pre codingTask__diff" data-testid="coding-diff">
          {diff}
        </pre>
      ) : null}

      {(task.status === 'review' || task.status === 'working') && (
        <form
          className="codingTask__row"
          onSubmit={(event) => {
            event.preventDefault();
            const message = followUp.trim();
            if (message) void run(() => api.followUp(task.id, message).then(() => setFollowUp('')));
          }}
        >
          <input aria-label="Follow-up" placeholder="Ask for more" value={followUp} onChange={(event) => setFollowUp(event.target.value)} />
          <button type="submit" disabled={busy || !followUp.trim()}>
            Follow-up
          </button>
        </form>
      )}

      <div className="codingTask__actions">
        {HAS_DIFF.includes(task.status) ? (
          <button type="button" disabled={busy} onClick={() => void toggleDiff()}>
            {diff === null ? 'Open diff' : 'Hide diff'}
          </button>
        ) : null}
        {task.status === 'review' ? (
          <button
            type="button"
            className="approvals__approve"
            disabled={busy || (review?.protected_violations?.length ?? 0) > 0}
            onClick={() => void run(() => api.apply(task.id))}
          >
            {workspace?.kind === 'self' ? 'Approve and open pull request' : 'Apply (open pull request)'}
          </button>
        ) : null}
        {['review', 'failed', 'cancelled'].includes(task.status) ? (
          <button type="button" disabled={busy} onClick={() => void run(() => api.discard(task.id))}>
            Discard
          </button>
        ) : null}
        {CANCELLABLE.includes(task.status) ? (
          <button type="button" disabled={busy} onClick={() => void run(() => api.cancel(task.id))}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="codingTask__error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function StartTaskForm({ api, workspaces, onStarted }: { api: CodingTasksBridge; workspaces: CodingWorkspace[]; onStarted: () => void }) {
  const [workspace, setWorkspace] = useState('');
  const [goal, setGoal] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = workspace || workspaces[0]?.id || '';

  if (workspaces.length === 0) return null;
  return (
    <form
      className="codingTask codingTask--new"
      aria-label="Start a task"
      onSubmit={(event) => {
        event.preventDefault();
        if (!goal.trim() || !chosen) return;
        setBusy(true);
        setError(null);
        api
          .start({ workspace_id: chosen, goal: goal.trim(), acceptance: acceptance.split('\n').map((line) => line.trim()).filter(Boolean) })
          .then(() => {
            setGoal('');
            setAcceptance('');
            onStarted();
          })
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    >
      <b>Start a task</b>
      <label>
        Workspace
        <select value={chosen} onChange={(event) => setWorkspace(event.target.value)}>
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Goal
        <textarea rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} />
      </label>
      <label>
        Acceptance (one per line, optional)
        <textarea rows={2} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} />
      </label>
      <div className="codingTask__actions">
        <button type="submit" disabled={busy || !goal.trim()}>
          Start
        </button>
      </div>
      {error ? (
        <p className="codingTask__error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
