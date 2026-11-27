/**
 * The tools an agent uses to plan its own time (docs/features/agent-time.md): reminders, wake-ups, watches, goals and
 * intentions, flows (small workflows it writes itself), and sleep. Each one is a call to the workflows service for the
 * avatar that called the tool (ToolContext.avatarId, Echo when none). They are registered only when WORKFLOWS_ENABLED is
 * not 0. None needs approval; a `confirm` tool that a flow calls still goes through the approval card when it runs.
 *
 * A flow the service refuses (HTTP 422) comes back as a tool error that lists every problem, so the model can fix it.
 */
import type { JSONSchema } from '../shared/mcp/types.js';
import type { RegisteredTool, ToolContext } from '../tools/tool-registry.js';
import { WorkflowsError, type WorkflowsClient } from './workflows-client.js';

export const WORKFLOW_TOOL_SERVER_ID = 'workflows';
export const WORKFLOW_TOOL_NAMES = [
  'remind_me',
  'wake_me_later',
  'watch_for',
  'write_flow',
  'run_flow',
  'my_flows',
  'set_intention',
  'set_goal',
  'my_plans',
  'change_plan',
  'drop_plan',
  'go_to_sleep',
] as const;

const DEFAULT_AVATAR = 'echo';
const MAX_RESULT_CHARS = 6000;

export interface AgentTimeToolsOptions {
  client: Pick<
    WorkflowsClient,
    | 'createReminder'
    | 'createWakeup'
    | 'createWatch'
    | 'listFlows'
    | 'getFlow'
    | 'putFlow'
    | 'runFlow'
    | 'createIntention'
    | 'plans'
    | 'signalPlan'
    | 'dropPlan'
    | 'sleep'
  >;
  now?: () => Date;
}

function readString(params: unknown, key: string): string | undefined {
  if (params && typeof params === 'object' && key in params) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readNumber(params: unknown, key: string): number | undefined {
  if (params && typeof params === 'object' && key in params) {
    const value = (params as Record<string, unknown>)[key];
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readObject(params: unknown, key: string): Record<string, unknown> | undefined {
  if (!params || typeof params !== 'object') return undefined;
  let value = (params as Record<string, unknown>)[key];
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function json(value: unknown): string {
  return clip(JSON.stringify(value ?? null, null, 1), MAX_RESULT_CHARS);
}

/** When something should happen: an ISO time (`at`, or `when` as text) or a number of seconds from now (`inSeconds`, or `when` as a number). */
function readWhen(params: unknown, now: Date): { at?: string; inSeconds?: number } {
  const at = readString(params, 'at');
  const inSeconds = readNumber(params, 'inSeconds');
  const when =
    params && typeof params === 'object' ? (params as Record<string, unknown>).when : undefined;
  if (inSeconds !== undefined) return { inSeconds: Math.max(1, Math.round(inSeconds)) };
  const text = at ?? (typeof when === 'string' ? when.trim() : undefined);
  if (text) {
    const time = Date.parse(text);
    if (Number.isNaN(time))
      throw new Error(
        `I could not read the time "${text}". Use an ISO time such as ${new Date(now.getTime() + 3_600_000).toISOString()}, or inSeconds.`,
      );
    return { at: new Date(time).toISOString() };
  }
  if (typeof when === 'number' && Number.isFinite(when))
    return { inSeconds: Math.max(1, Math.round(when)) };
  throw new Error('Say when: "at" (an ISO time) or "inSeconds" (a number of seconds from now).');
}

/** A service error as a message the model can act on. */
function failure(error: unknown): Error {
  if (error instanceof WorkflowsError) {
    if (error.status === 422 && error.errors.length > 0) {
      return new Error(
        `The service refused this. Fix these and call again:\n- ${error.errors.join('\n- ')}`,
      );
    }
    return new Error(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

const WHEN_PROPERTIES: Record<string, JSONSchema> = {
  at: {
    type: 'string',
    description:
      'Optional. When, as an ISO 8601 time with offset, e.g. "2026-11-26T07:30:00+08:00".',
  },
  inSeconds: {
    type: 'number',
    description: 'Optional, instead of "at". How many seconds from now, e.g. 600 for ten minutes.',
  },
};

export const FLOW_LANGUAGE = [
  'A flow is {"inputs": {name: default}, "steps": [step, ...]}. The trigger says when it runs. Each step is an object with one step key, plus an optional "as": "name" that keeps its result in a variable. Write {{name}} in any text to use a variable or input (unknown names become empty).',
  'Steps:',
  '{"think": "prompt", "tools": false} thinks and returns text.',
  '{"choose": "question", "options": ["a","b"]} returns one of the options.',
  '{"recall": "query"} returns what your memory says. {"remember": "fact"} saves a fact. {"search": "query"} returns web results.',
  '{"tool": "toolName", "params": {...}} runs one of your tools (a tool that needs approval still asks Kevin).',
  '{"say": "text", "urgent": false} says something to Kevin when it suits him. {"ask": "question"} asks Kevin yes or no and returns "yes" or "no".',
  '{"wait": {"seconds": 600}} or {"wait": {"until": "07:30"}} waits. {"wait_for": {"entityId": "binary_sensor.door", "state": "on"} or {"signal": "name"}, "timeoutSeconds": 3600} returns "ok" or "timeout".',
  '{"if": {"var": "x", "op": "eq|ne|contains|gt|lt|truthy|falsy", "value": 1}, "then": [steps], "else": [steps]}.',
  '{"repeat": {"times": 3} or {"until": {same condition as if}}, "steps": [steps]}. {"run_flow": "other_flow", "inputs": {...}}. {"set_intention": "text", "kind": "intention"}.',
  'Trigger: {"kind": "manual"}, {"kind": "schedule", "cron": "30 7 * * 1-5"}, {"kind": "schedule", "everyMinutes": 60}, or {"kind": "watch", "condition": {...as in watch_for}}.',
].join('\n');

export function createAgentTimeTools(options: AgentTimeToolsOptions): RegisteredTool[] {
  const { client } = options;
  const now = options.now ?? (() => new Date());
  const avatar = (context?: ToolContext): string => context?.avatarId || DEFAULT_AVATAR;
  const define = (tool: Omit<RegisteredTool, 'id' | 'serverId' | 'enabled'>): RegisteredTool => ({
    ...tool,
    id: `${WORKFLOW_TOOL_SERVER_ID}:${tool.toolName}`,
    serverId: WORKFLOW_TOOL_SERVER_ID,
    enabled: true,
  });
  /** Runs `work`, turning a service failure into a clear error. */
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw failure(error);
    }
  };

  const remind: RegisteredTool = define({
    toolName: 'remind_me',
    description:
      'Set a reminder for yourself to tell Kevin something at a time. It survives a restart of the app. Give "text" (what to say) and either "at" (ISO time) or "inSeconds". ' +
      'It is spoken as soon as it is due. Use it when you promise "I will remind you". ' +
      'Example: {"text": "The bins go out tonight.", "at": "2026-11-26T18:00:00+08:00"}.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to remind Kevin of, in a short sentence.' },
        ...WHEN_PROPERTIES,
        alarm: {
          type: 'boolean',
          description: 'Optional, no longer needed: every reminder is spoken when due.',
        },
      },
      required: ['text'],
    },
    confirmationLevel: 'notify',
    describeCall: (params) => `remind: ${clip(readString(params, 'text') ?? '', 60)}`,
    execute: async (params, context) => {
      const text = readString(params, 'text');
      if (!text) throw new Error('remind_me needs "text".');
      const when = readWhen(params, now());
      const alarm = (params as { alarm?: unknown } | null)?.alarm === true;
      const made = await guarded(() =>
        client.createReminder({
          avatarId: avatar(context),
          ...when,
          text,
          ...(alarm ? { alarm } : {}),
        }),
      );
      return `Reminder set for ${made.dueAt}.`;
    },
  });

  const wake: RegisteredTool = define({
    toolName: 'wake_me_later',
    description:
      'Ask to be woken later to think about something again. At that time you get your note back and may then speak or act. Give "note" and either "inSeconds" or "at". ' +
      'Example: {"note": "Check whether Kevin liked the new playlist.", "inSeconds": 7200}.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'What to think about then, in your own words.' },
        ...WHEN_PROPERTIES,
      },
      required: ['note'],
    },
    confirmationLevel: 'none',
    describeCall: (params) => `wake me: ${clip(readString(params, 'note') ?? '', 60)}`,
    execute: async (params, context) => {
      const note = readString(params, 'note');
      if (!note) throw new Error('wake_me_later needs "note".');
      const when = readWhen(params, now());
      const made = await guarded(() =>
        client.createWakeup({ avatarId: avatar(context), ...when, note }),
      );
      return `I will wake you at ${made.dueAt}.`;
    },
  });

  const watch: RegisteredTool = define({
    toolName: 'watch_for',
    description:
      'Keep an eye on something and act when it happens, even while nobody is talking to you. "condition" is one of: ' +
      '{"kind":"entity","entityId":"binary_sensor.front_door","state":"on"}; ' +
      '{"kind":"entity","entityId":"sensor.washer_power","below":5,"forSeconds":180} (or "above"); ' +
      '{"kind":"search","query":"...","everyMinutes":60} (a new web result); ' +
      '{"kind":"service","url":"http://...","everyMinutes":5} (it stops answering); ' +
      '{"kind":"coding_task","taskId":"..."} (the task finishes). ' +
      '"then" is {"say":"text"} or {"think":"prompt"} or {"flow":"name","inputs":{}}. "untilHours" (default 24, at most 720) is how long to keep watching. ' +
      'Example: {"condition": {"kind":"entity","entityId":"sensor.washer_power","below":5,"forSeconds":180}, "then": {"say":"The washing is done."}}.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'object', description: 'What to watch for (see the description).' },
        then: { type: 'object', description: 'What to do when it happens (see the description).' },
        untilHours: {
          type: 'number',
          description: 'Optional. Stop watching after this many hours (default 24).',
        },
      },
      required: ['condition', 'then'],
    },
    confirmationLevel: 'none',
    describeCall: () => 'start a watch',
    execute: async (params, context) => {
      const condition = readObject(params, 'condition');
      const then = readObject(params, 'then');
      if (!condition) throw new Error('watch_for needs a "condition" object.');
      if (!then) throw new Error('watch_for needs a "then" object.');
      const untilHours = readNumber(params, 'untilHours');
      const made = await guarded(() =>
        client.createWatch({
          avatarId: avatar(context),
          condition,
          then: then as never,
          ...(untilHours !== undefined ? { untilHours } : {}),
        }),
      );
      return `Watching (${made.workflowId}).`;
    },
  });

  const writeFlow: RegisteredTool = define({
    toolName: 'write_flow',
    description:
      `Write (or replace) a flow: a small routine of your own that runs on a schedule, when a watch fires, or when you run it. Give "name" (lowercase letters, digits, - and _), "description", "definition" and "trigger". ${FLOW_LANGUAGE}\n` +
      'If the service finds a problem it tells you exactly where; fix it and call again. ' +
      'Example: {"name":"morning_bins","description":"Weekday reminder about the bins","trigger":{"kind":"schedule","cron":"30 7 * * 1-5"},"definition":{"inputs":{"city":"Singapore"},"steps":[{"search":"{{city}} weather today","as":"weather"},{"think":"Write one short sentence about today and the bins. Weather: {{weather}}","as":"line"},{"say":"{{line}}"}]}}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The flow name, such as "morning_bins".' },
        description: { type: 'string', description: 'One sentence on what it does.' },
        definition: { type: 'object', description: '{"inputs": {...}, "steps": [...]}' },
        trigger: { type: 'object', description: '{"kind": "manual"} or a schedule or a watch.' },
        enabled: { type: 'boolean', description: 'Optional. False to save it switched off.' },
      },
      required: ['name', 'description', 'definition', 'trigger'],
    },
    confirmationLevel: 'none',
    describeCall: (params) => `write flow ${readString(params, 'name') ?? ''}`.trim(),
    execute: async (params, context) => {
      const name = readString(params, 'name');
      const description = readString(params, 'description');
      const definition = readObject(params, 'definition');
      const trigger = readObject(params, 'trigger');
      if (!name) throw new Error('write_flow needs a "name".');
      if (!description) throw new Error('write_flow needs a "description".');
      if (!definition) throw new Error('write_flow needs a "definition" object with "steps".');
      if (!trigger) throw new Error('write_flow needs a "trigger" object.');
      const enabled = (params as { enabled?: unknown } | null)?.enabled;
      const saved = await guarded(() =>
        client.putFlow(avatar(context), name, {
          description,
          definition,
          trigger,
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        }),
      );
      const version = typeof saved.version === 'number' ? ` (version ${saved.version})` : '';
      return `Saved flow ${name}${version}. Trigger: ${JSON.stringify(trigger)}.`;
    },
  });

  const runFlow: RegisteredTool = define({
    toolName: 'run_flow',
    description:
      'Run one of your flows now. Give its "name" and, if it takes inputs, "inputs". Example: {"name": "morning_bins", "inputs": {"city": "Perth"}}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The flow name.' },
        inputs: { type: 'object', description: 'Optional. Values for the flow inputs.' },
      },
      required: ['name'],
    },
    confirmationLevel: 'none',
    describeCall: (params) => `run flow ${readString(params, 'name') ?? ''}`.trim(),
    execute: async (params, context) => {
      const name = readString(params, 'name');
      if (!name) throw new Error('run_flow needs a "name".');
      const inputs = readObject(params, 'inputs');
      const started = await guarded(() => client.runFlow(avatar(context), name, inputs));
      return `Started flow ${name} (${started.workflowId}).`;
    },
  });

  const myFlows: RegisteredTool = define({
    toolName: 'my_flows',
    description:
      'List the flows you have written, with their triggers. Give "name" to see one flow in full, steps included. Example: {} or {"name": "morning_bins"}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional. A flow name, to see all of it.' },
      },
    },
    confirmationLevel: 'none',
    readOnly: true,
    describeCall: () => 'your flows',
    execute: async (params, context) => {
      const name = readString(params, 'name');
      if (name) return json(await guarded(() => client.getFlow(avatar(context), name)));
      const { flows } = await guarded(() => client.listFlows(avatar(context)));
      return flows.length === 0 ? 'You have not written any flows yet.' : json(flows);
    },
  });

  const intention =
    (kind: 'goal' | 'intention'): ((params: unknown, context?: ToolContext) => Promise<string>) =>
    async (params, context) => {
      const text = readString(params, 'text');
      if (!text) throw new Error(`${kind === 'goal' ? 'set_goal' : 'set_intention'} needs "text".`);
      const dueRaw = kind === 'intention' ? readString(params, 'dueAt') : undefined;
      let dueAt: string | undefined;
      if (dueRaw) {
        const time = Date.parse(dueRaw);
        if (Number.isNaN(time))
          throw new Error(`I could not read the time "${dueRaw}". Use an ISO time.`);
        dueAt = new Date(time).toISOString();
      }
      const why = readString(params, 'why');
      await guarded(() =>
        client.createIntention({
          avatarId: avatar(context),
          kind,
          text,
          ...(why ? { why } : {}),
          ...(dueAt ? { dueAt } : {}),
        }),
      );
      return kind === 'goal' ? 'Goal kept.' : 'Intention kept.';
    };

  const setIntention: RegisteredTool = define({
    toolName: 'set_intention',
    description:
      'Write down something you mean to do, so you do not forget it. It shows in your notes at the start of each conversation. A promise you make to Kevin should become an intention or a reminder. ' +
      'Give "text", and optionally "why" and "dueAt" (ISO time). Example: {"text": "Ask Kevin how the interview went.", "why": "He was nervous.", "dueAt": "2026-11-27T09:00:00+08:00"}.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What you intend to do.' },
        why: { type: 'string', description: 'Optional. Why it matters.' },
        dueAt: { type: 'string', description: 'Optional. When, as an ISO time.' },
      },
      required: ['text'],
    },
    confirmationLevel: 'none',
    describeCall: (params) => `intention: ${clip(readString(params, 'text') ?? '', 60)}`,
    execute: intention('intention'),
  });

  const setGoal: RegisteredTool = define({
    toolName: 'set_goal',
    description:
      'Keep a longer goal of your own, something that lasts days or weeks. Give "text" and optionally "why". Example: {"text": "Learn what Kevin likes to cook.", "why": "I want to suggest good dinners."}.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The goal.' },
        why: { type: 'string', description: 'Optional. Why it matters.' },
      },
      required: ['text'],
    },
    confirmationLevel: 'none',
    describeCall: (params) => `goal: ${clip(readString(params, 'text') ?? '', 60)}`,
    execute: intention('goal'),
  });

  const myPlans: RegisteredTool = define({
    toolName: 'my_plans',
    description:
      'See what is going on in your own time: running reminders, watches and flows (with their workflow ids), your open goals and intentions, and your flows. Example: {}.',
    inputSchema: { type: 'object', properties: {} },
    confirmationLevel: 'none',
    readOnly: true,
    describeCall: () => 'your plans',
    execute: async (_params, context) => json(await guarded(() => client.plans(avatar(context)))),
  });

  const changePlan: RegisteredTool = define({
    toolName: 'change_plan',
    description:
      'Change something running in your own time, by its workflow id from my_plans. "signal" is "pause", "resume", "snooze" (give args {"seconds": 3600}) or "note" (args {"text": "..."}). ' +
      'Example: {"workflowId": "watch:1234", "signal": "snooze", "args": {"seconds": 3600}}.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The workflow id from my_plans.' },
        signal: {
          type: 'string',
          enum: ['pause', 'resume', 'snooze', 'note'],
          description: 'What to do.',
        },
        args: { type: 'object', description: 'Optional. For snooze: {"seconds": n}.' },
      },
      required: ['workflowId', 'signal'],
    },
    confirmationLevel: 'none',
    describeCall: (params) =>
      `${readString(params, 'signal') ?? 'change'} ${readString(params, 'workflowId') ?? 'a plan'}`,
    execute: async (params) => {
      const workflowId = readString(params, 'workflowId');
      const signal = readString(params, 'signal');
      if (!workflowId || !signal) throw new Error('change_plan needs "workflowId" and "signal".');
      await guarded(() => client.signalPlan(workflowId, signal, readObject(params, 'args')));
      return `Sent ${signal} to ${workflowId}.`;
    },
  });

  const dropPlan: RegisteredTool = define({
    toolName: 'drop_plan',
    description:
      'Cancel a reminder, watch, wake-up or flow schedule by its workflow id from my_plans, and say why. Example: {"workflowId": "watch:1234", "why": "Kevin already did it."}.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The workflow id from my_plans.' },
        why: { type: 'string', description: 'Why you are dropping it.' },
      },
      required: ['workflowId', 'why'],
    },
    confirmationLevel: 'none',
    describeCall: (params) => `drop ${readString(params, 'workflowId') ?? 'a plan'}`,
    execute: async (params) => {
      const workflowId = readString(params, 'workflowId');
      if (!workflowId) throw new Error('drop_plan needs "workflowId".');
      await guarded(() => client.dropPlan(workflowId, readString(params, 'why')));
      return `Dropped ${workflowId}.`;
    },
  });

  const goToSleep: RegisteredTool = define({
    toolName: 'go_to_sleep',
    description:
      'Go to sleep: stop idle moves and reading, and only be woken by urgent news or by Kevin speaking to you. You wake when he talks to you or after some hours. Use it when you are tired or it is late and nothing is going on. Give a short "reason". Example: {"reason": "It is late and Kevin has gone to bed."}.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why you are going to sleep.' } },
      required: ['reason'],
    },
    confirmationLevel: 'none',
    describeCall: () => 'go to sleep',
    execute: async (params, context) => {
      await guarded(() =>
        client.sleep(avatar(context), readString(params, 'reason') ?? 'by my own choice'),
      );
      return 'Going to sleep.';
    },
  });

  return [
    remind,
    wake,
    watch,
    writeFlow,
    runFlow,
    myFlows,
    setIntention,
    setGoal,
    myPlans,
    changePlan,
    dropPlan,
    goToSleep,
  ];
}
