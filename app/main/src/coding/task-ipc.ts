/** IPC for the task cards on the status panel: list, follow and control coding tasks. */
import type { CodingRunnerClient, RunnerAnswer, RunnerEvent, RunnerTask, RunnerTaskRequest } from './runner-client.js';

export interface CodingTaskIpcOptions {
  ipcMain: { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void };
  client: () => CodingRunnerClient | null;
  /** Subscribe to the runner's event stream. */
  onRunnerEvent: (listener: (event: RunnerEvent) => void) => () => void;
  broadcast: (channel: string, payload: unknown) => void;
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

export function registerCodingTaskIpc(options: CodingTaskIpcOptions): () => void {
  const client = (): CodingRunnerClient => {
    const current = options.client();
    if (!current) throw new Error('The coding runner is not connected.');
    return current;
  };
  const on = (channel: string, fn: (...args: unknown[]) => unknown) => options.ipcMain.handle(channel, (_event, ...args) => fn(...args));
  on('coding:tasks', () => client().listTasks());
  on('coding:task', (id: unknown) => client().getTask(str(id, 'id')));
  on('coding:diff', (id: unknown) => client().taskDiff(str(id, 'id')));
  on('coding:start-task', (request: unknown) => {
    const r = (request ?? {}) as Partial<RunnerTaskRequest>;
    const acceptance = Array.isArray(r.acceptance) ? r.acceptance.filter((a): a is string => typeof a === 'string' && a.trim() !== '') : [];
    return client().createTask({ workspace_id: str(r.workspace_id, 'workspace'), goal: str(r.goal, 'goal'), acceptance });
  });
  on('coding:answer-task', (id: unknown, answer: unknown) => {
    const a = (answer ?? {}) as RunnerAnswer;
    return client().answer(str(id, 'id'), {
      ...(typeof a.value === 'string' ? { value: a.value } : {}),
      ...(typeof a.confirmed === 'boolean' ? { confirmed: a.confirmed } : {}),
      ...(a.cancelled === true ? { cancelled: true } : {}),
      ...(typeof a.dialog_id === 'string' ? { dialog_id: a.dialog_id } : {}),
    });
  });
  on('coding:follow-up', (id: unknown, message: unknown) => client().followUp(str(id, 'id'), str(message, 'message')));
  on('coding:cancel-task', (id: unknown) => client().cancel(str(id, 'id')));
  on('coding:discard-task', (id: unknown) => client().discard(str(id, 'id')));
  // The Apply button is Kevin's own decision, so it needs no further approval.
  on('coding:apply-task', (id: unknown) => client().apply(str(id, 'id')));
  return options.onRunnerEvent((event) => {
    if (event.task_id) options.broadcast('coding:task-event', event);
  });
}

export type { RunnerTask };
