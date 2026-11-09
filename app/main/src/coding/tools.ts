/**
 * The tools Echo (the voice model) uses to hand coding work to the runner and follow it. Few and
 * plain on purpose: a small local model has to pick them. Every result is a few short lines.
 * Starting a task and opening a pull request need Kevin's approval ('confirm'); for a workspace
 * of kind 'self' (Echo's own code) opening the pull request can only be approved on the card.
 */
import type { RegisteredTool } from '../tools/tool-registry.js';
import type { CodingRunnerClient, RunnerQuestion, RunnerTask } from './runner-client.js';
import type { CodingWorkspace } from './types.js';

export const CODING_SERVER_ID = 'coding';

export const CODING_TOOL_IDS = {
  capabilities: 'coding:coding_capabilities',
  list: 'coding:list_coding_tasks',
  status: 'coding:coding_task_status',
  start: 'coding:start_coding_task',
  steer: 'coding:steer_coding_task',
  answer: 'coding:answer_coding_question',
  review: 'coding:review_coding_task',
  apply: 'coding:apply_coding_task',
  discard: 'coding:discard_coding_task',
} as const;

type Client = Pick<
  CodingRunnerClient,
  'capabilities' | 'getSettings' | 'listTasks' | 'createTask' | 'steer' | 'followUp' | 'answer' | 'apply' | 'discard' | 'getWorkspaces'
>;

export interface CodingToolsDeps {
  client: () => Client | null;
  /** The workspaces in Kevin's settings (names and kinds). */
  workspaces: () => CodingWorkspace[];
  /** Called before a call whose result Echo sees at once, so the matching event is not sent again as an update. */
  suppressNudge?: (taskId: string, status: string) => void;
}

const MAX_RESULT_CHARS = 2500;

function readString(params: unknown, key: string): string | undefined {
  if (params && typeof params === 'object' && key in params) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readList(params: unknown, key: string): string[] {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
  return items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function fit(lines: string[], limit = MAX_RESULT_CHARS): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > limit) {
      out.push('(more not shown)');
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

export function createCodingTools(deps: CodingToolsDeps): RegisteredTool[] {
  const need = (): Client => {
    const client = deps.client();
    if (!client) throw new Error('The coding runner is not running.');
    return client;
  };
  const wsName = (id: string | undefined) => deps.workspaces().find((ws) => ws.id === id)?.name ?? id ?? '?';
  const wsKind = (id: string | undefined) => deps.workspaces().find((ws) => ws.id === id)?.kind;

  /** The task named by task_id (a full id, or the end of one), else the newest task in one of `statuses`. */
  const pickTask = async (params: unknown, statuses?: string[], onlyOne = false): Promise<RunnerTask> => {
    const tasks = await need().listTasks();
    const id = readString(params, 'task_id');
    if (id) {
      const exact = tasks.find((task) => task.id === id);
      if (exact) return exact;
      const partial = tasks.filter((task) => task.id.endsWith(id) || task.id.startsWith(id));
      if (partial.length === 1) return partial[0];
      throw new Error(`There is no coding task ${id}. Use list_coding_tasks to see the ids.`);
    }
    const fitting = tasks.filter((task) => !statuses || statuses.includes(task.status));
    if (onlyOne && fitting.length > 1) throw new Error(`Several tasks are ${statuses?.join(' or ')}. Say which one with task_id (see list_coding_tasks).`);
    const found = fitting[0];
    if (!found) throw new Error(statuses ? `No coding task is ${statuses.join(' or ')} right now.` : 'There are no coding tasks yet.');
    return found;
  };

  const taskLine = (task: RunnerTask) =>
    `${task.id} [${wsName(task.workspace_id)}] ${clip(task.goal ?? '', 70)} - ${task.status}${task.pr_url ? ` ${task.pr_url}` : ''}`;

  const questionLine = (q: RunnerQuestion) =>
    `[${q.id}] ${q.kind === 'confirm' ? `asks permission (${clip(q.title ?? '', 60)}): ${clip(q.message ?? '', 160)}` : clip(q.message ?? q.title ?? '', 240)}`;

  const withTask = (extra: Record<string, unknown>) => ({ type: 'string', description: 'The task id. Optional: the most recent fitting task is used.', ...extra });

  const capabilities: RegisteredTool = {
    id: CODING_TOOL_IDS.capabilities,
    serverId: CODING_SERVER_ID,
    toolName: 'coding_capabilities',
    description:
      'What the coding agent can work on: the workspaces (projects) it may change, the model it uses, and how its past tasks went. ' +
      'Call it before starting a task if you are unsure which workspace to use.',
    inputSchema: { type: 'object', properties: {} },
    enabled: true,
    confirmationLevel: 'none',
    spokenNotice: 'Let me check what the coding agent can do.',
    describeCall: () => 'coding agent capabilities',
    execute: async () => {
      const client = need();
      const [caps, settings] = await Promise.all([client.capabilities(), client.getSettings().catch(() => null)]);
      const record = (caps as { track_record?: Array<Record<string, unknown>> }).track_record ?? [];
      const lines = ['Workspaces:'];
      for (const ws of deps.workspaces()) {
        const mine = record.filter((r) => r.workspace_id === ws.id);
        const sum = (key: string) => mine.reduce((total, r) => total + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);
        const history = mine.length ? `${sum('started')} started, ${sum('done')} done, ${sum('failed')} failed, ${sum('with_pr')} with a pull request` : 'no tasks yet';
        lines.push(`- ${ws.name}${ws.kind === 'self' ? ' (your own code)' : ''}: ${history}`);
      }
      if (lines.length === 1) lines.push('- none set up');
      if (settings?.default_model) lines.push(`Model: ${settings.default_model.id} (${settings.default_model.provider}).`);
      const models = (caps.backend?.models ?? []).length;
      if (caps.backend?.error) lines.push(`Agent problem: ${clip(caps.backend.error, 120)}`);
      else if (models) lines.push(`${models} model(s) available to the agent.`);
      return fit(lines);
    },
  };

  const list: RegisteredTool = {
    id: CODING_TOOL_IDS.list,
    serverId: CODING_SERVER_ID,
    toolName: 'list_coding_tasks',
    description: 'List the recent coding tasks, newest first, one line each: id, workspace, goal, status, pull request link.',
    inputSchema: { type: 'object', properties: {} },
    enabled: true,
    confirmationLevel: 'none',
    spokenNotice: 'Let me look at the coding tasks.',
    describeCall: () => 'coding tasks',
    execute: async () => {
      const tasks = await need().listTasks();
      return tasks.length ? fit(tasks.slice(0, 8).map(taskLine)) : 'There are no coding tasks yet.';
    },
  };

  const status: RegisteredTool = {
    id: CODING_TOOL_IDS.status,
    serverId: CODING_SERVER_ID,
    toolName: 'coding_task_status',
    description:
      'How one coding task is going: status, what it is doing now, files touched, questions waiting for an answer, review summary, pull request, error.',
    inputSchema: { type: 'object', properties: { task_id: withTask({}) } },
    enabled: true,
    confirmationLevel: 'none',
    spokenNotice: 'Let me check on the coding agent.',
    describeCall: (params) => `status of coding task ${readString(params, 'task_id') ?? '(latest)'}`,
    execute: async (params) => {
      const task = await pickTask(params);
      const lines = [`Task ${task.id} in ${wsName(task.workspace_id)}: ${clip(task.goal ?? '', 160)}`];
      lines.push(`Status: ${task.status}${task.phase_detail ? ` (${clip(task.phase_detail, 120)})` : ''}.${task.current_tool ? ` Now using: ${task.current_tool}.` : ''}`);
      const files = task.files_touched ?? [];
      if (files.length) lines.push(`Files touched (${files.length}): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', and more' : ''}`);
      for (const q of task.questions ?? []) lines.push(`Waiting for an answer ${questionLine(q)}`);
      if (task.review) lines.push(`Review: ${task.review.summary ?? 'no summary'}${task.checks_ok === null || task.checks_ok === undefined ? '' : `; checks ${task.checks_ok ? 'passed' : 'failed'}`}.`);
      if (task.pr_url) lines.push(`Pull request: ${task.pr_url}`);
      if (task.error) lines.push(`Error: ${clip(task.error, 200)}`);
      return fit(lines);
    },
  };

  const start: RegisteredTool = {
    id: CODING_TOOL_IDS.start,
    serverId: CODING_SERVER_ID,
    toolName: 'start_coding_task',
    description:
      'Hand a coding job to the coding agent. It works in the background on its own branch and you hear back when it has a question or is ready for review. ' +
      'Write a precise brief: say exactly what to change and why, in the goal; list how to know it is done in acceptance; list paths it should stay within in scope. ' +
      'The agent cannot ask Kevin anything except through you. Kevin has to approve first, so after calling this, ask him.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or id (see coding_capabilities).' },
        goal: { type: 'string', description: 'What to do, in a few precise sentences.' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'Optional. Things that must be true when it is done, such as "tests pass".' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Optional. Paths the change should stay within.' },
      },
      required: ['workspace', 'goal'],
    },
    enabled: true,
    confirmationLevel: 'confirm',
    describeCall: (params) => `start a coding task in ${readString(params, 'workspace') ?? 'a workspace'}: ${clip(readString(params, 'goal') ?? '', 90)}`,
    execute: async (params) => {
      const goal = readString(params, 'goal');
      if (!goal) throw new Error('start_coding_task needs a goal.');
      const wanted = readString(params, 'workspace')?.toLowerCase();
      const known = deps.workspaces();
      const ws = wanted ? known.find((w) => w.id.toLowerCase() === wanted || w.name.toLowerCase() === wanted) : known.length === 1 ? known[0] : undefined;
      if (!ws) throw new Error(`Unknown workspace. Choose one of: ${known.map((w) => w.name).join(', ') || 'none set up'}.`);
      const task = await need().createTask({ workspace_id: ws.id, goal, acceptance: readList(params, 'acceptance'), scope: readList(params, 'scope') });
      return `Started task ${task.id} in ${ws.name}${task.status === 'queued' ? ' (waiting in the queue)' : ''}. It runs in the background. You will get an update when it has a question or is ready for review.`;
    },
  };

  const steer: RegisteredTool = {
    id: CODING_TOOL_IDS.steer,
    serverId: CODING_SERVER_ID,
    toolName: 'steer_coding_task',
    description: 'Send the coding agent a message about a task: a correction while it works, or a further request once it is in review.',
    inputSchema: { type: 'object', properties: { task_id: withTask({}), message: { type: 'string', description: 'What to tell the agent.' } }, required: ['message'] },
    enabled: true,
    confirmationLevel: 'notify',
    describeCall: (params) => `message the coding agent: ${clip(readString(params, 'message') ?? '', 80)}`,
    execute: async (params) => {
      const message = readString(params, 'message');
      if (!message) throw new Error('steer_coding_task needs a message.');
      const task = await pickTask(params, ['working', 'question', 'review']);
      if (task.status === 'working' || (task.status === 'question' && (task.questions ?? []).some((q) => q.kind !== 'text'))) await need().steer(task.id, message);
      else await need().followUp(task.id, message);
      return `Sent to task ${task.id}.`;
    },
  };

  const answer: RegisteredTool = {
    id: CODING_TOOL_IDS.answer,
    serverId: CODING_SERVER_ID,
    toolName: 'answer_coding_question',
    description:
      'Answer a question the coding agent asked. For a permission question answer yes or no, but only after Kevin said so. ' +
      'If you do not know the answer, ask Kevin first.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: withTask({}),
        answer: { type: 'string', description: 'The answer.' },
        dialog_id: { type: 'string', description: 'Optional. Which question, when several wait (the id in brackets).' },
      },
      required: ['answer'],
    },
    enabled: true,
    confirmationLevel: 'notify',
    describeCall: (params) => `answer the coding agent: ${clip(readString(params, 'answer') ?? '', 80)}`,
    execute: async (params) => {
      const text = readString(params, 'answer');
      if (!text) throw new Error('answer_coding_question needs an answer.');
      const task = await pickTask(params, ['question']);
      const wanted = readString(params, 'dialog_id');
      const question = wanted ? (task.questions ?? []).find((q) => q.id === wanted) : (task.questions ?? [])[0];
      if (!question) throw new Error(`Task ${task.id} has no such question waiting.`);
      let body: { value?: string; confirmed?: boolean; dialog_id: string };
      if (question.kind === 'confirm') {
        const yes = /^(yes|y|ok|okay|sure|approve|approved|go ahead|allow)\b/i.test(text);
        const no = /^(no|n|don'?t|deny|decline|stop|cancel)\b/i.test(text);
        if (!yes && !no) throw new Error('That question needs a yes or no.');
        body = { confirmed: yes, dialog_id: question.id };
      } else {
        body = { value: text, dialog_id: question.id };
      }
      await need().answer(task.id, body);
      return `Answered task ${task.id}.`;
    },
  };

  const review: RegisteredTool = {
    id: CODING_TOOL_IDS.review,
    serverId: CODING_SERVER_ID,
    toolName: 'review_coding_task',
    description: 'Look at a finished coding task before opening a pull request: what changed, whether the checks passed, and anything to be careful about.',
    inputSchema: { type: 'object', properties: { task_id: withTask({}) } },
    enabled: true,
    confirmationLevel: 'none',
    spokenNotice: 'Let me look at the changes.',
    describeCall: (params) => `review coding task ${readString(params, 'task_id') ?? '(latest)'}`,
    execute: async (params) => {
      const task = await pickTask(params, ['review', 'done']);
      const rev = task.review;
      if (!rev) return `Task ${task.id} is ${task.status}; there is nothing to review yet.`;
      const lines = [`Task ${task.id}: ${rev.summary ?? 'no summary'}.`];
      if (task.checks_ok === null || task.checks_ok === undefined) lines.push('Checks: none configured.');
      else if (task.checks_ok) lines.push('Checks: passed.');
      else lines.push('Checks: FAILED. Last lines:', ...(task.checks_output ?? '').split('\n').slice(-12).map((line) => `  ${clip(line, 160)}`));
      const files = rev.files ?? [];
      lines.push('Diff stat:', ...files.slice(0, 40).map((f) => `  ${f.path} +${f.added} -${f.deleted}`));
      if (files.length > 40) lines.push(`  ...and ${files.length - 40} more files`);
      if (task.last_text) lines.push(`Agent summary: ${clip(task.last_text, 400)}`);
      const flags = rev.flags ?? [];
      const violations = rev.protected_violations ?? [];
      const concerns = [
        ...(task.checks_ok === false ? ['checks failed'] : []),
        ...violations.map((v) => `protected path changed: ${v}`),
        ...flags,
      ];
      lines.push(concerns.length ? `Verdict hint: be careful. ${concerns.join('; ')}.` : 'Verdict hint: looks fine to open a pull request.');
      return fit(lines);
    },
  };

  const apply: RegisteredTool = {
    id: CODING_TOOL_IDS.apply,
    serverId: CODING_SERVER_ID,
    toolName: 'apply_coding_task',
    description:
      'Open a pull request for a reviewed coding task: pushes its branch to GitHub. Kevin has to approve first, so after calling this, ask him. ' +
      'For your own code, he approves by tapping the card on screen; a spoken yes is not enough.',
    inputSchema: { type: 'object', properties: { task_id: withTask({}) } },
    enabled: true,
    confirmationLevel: 'confirm',
    describeCall: (params) => `open a pull request for coding task ${readString(params, 'task_id') ?? '(latest in review)'}`,
    cardOnly: async (params) => {
      const task = await pickTask(params, ['review'], true);
      return wsKind(task.workspace_id) === 'self';
    },
    execute: async (params) => {
      const task = await pickTask(params, ['review'], true);
      deps.suppressNudge?.(task.id, 'done');
      const done = await need().apply(task.id);
      return done.pr_url ? `Pull request opened: ${done.pr_url}` : `Done. ${clip(done.phase_detail ?? 'The branch was pushed.', 200)}`;
    },
  };

  const discard: RegisteredTool = {
    id: CODING_TOOL_IDS.discard,
    serverId: CODING_SERVER_ID,
    toolName: 'discard_coding_task',
    description: 'Throw away a coding task and its changes. Use it when Kevin does not want the result.',
    inputSchema: { type: 'object', properties: { task_id: withTask({}) } },
    enabled: true,
    confirmationLevel: 'notify',
    describeCall: (params) => `discard coding task ${readString(params, 'task_id') ?? '(latest in review)'}`,
    execute: async (params) => {
      const task = await pickTask(params, ['review'], true);
      await need().discard(task.id);
      return `Discarded task ${task.id}.`;
    },
  };

  return [capabilities, list, status, start, steer, answer, review, apply, discard];
}
