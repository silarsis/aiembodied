/**
 * The app's side of agent time. The workflows service asks the app to do something for an avatar by publishing an
 * `agent.act` event addressed to `service:app`; this handler does it and answers with `agent.act.result` on the same
 * transaction (state done or failed). It never throws: a failure is an answer with a code (offline, refused, bad_args,
 * failed, busy). One info line per act: `Agent act <kind> for <avatar> -> ok|failed (<ms> ms)`.
 *
 * Kinds: context, think, say, tool, ask, start_pursuit, return_home, sleep_state (docs/features/agent-time.md).
 * Everything the app owns comes in through `AgentActDeps`, so the tests run it with fakes.
 */
import type { SwitchboardBus } from '../switchboard/bus.js';
import type { SwitchboardEvent } from '../switchboard/types.js';
import { PursuitLlm, type LlmGate } from '../pursuits/pursuit-llm.js';
import type { PursuitOffer } from '../shared/pursuits/types.js';
import type { ChatClient } from '../local-voice/voice-engines.js';
import type { ApprovalOutcome } from '../tools/approvals.js';
import type { PendingApproval } from '../shared/tools/approvals-types.js';
import type { RegisteredTool, ToolContext, ToolExecutionResult } from '../tools/tool-registry.js';
import type { PresenceSnapshot } from '../presence/presence.js';
import type { Restlessness } from '../shared/rooms/idle-settings.js';
import { createQuestionTool } from './ask.js';
import type { AgentSleep } from './sleep.js';
import type { QuietSaves } from './quiet-saves.js';

type Logger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

export type ActCode = 'offline' | 'refused' | 'bad_args' | 'failed' | 'busy';

export class ActError extends Error {
  constructor(
    readonly code: ActCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActError';
  }
}

export const ACT_KINDS = [
  'context',
  'think',
  'say',
  'tool',
  'ask',
  'start_pursuit',
  'return_home',
  'sleep_state',
] as const;
export type ActKind = (typeof ACT_KINDS)[number];

/** How long a think waits for a live conversation to end before it gives up with code "busy". */
export const THINK_BUSY_WAIT_MS = 60_000;
/** A think that has not finished by now fails (the service gives up at 180 s). */
export const THINK_TIMEOUT_MS = 170_000;
/** At most this many tool calls in one think. */
export const THINK_MAX_TOOL_CALLS = 8;
/** An ask or a confirm tool waits at most this long when the act has no deadline. */
const DEFAULT_APPROVAL_WAIT_MS = 6 * 3_600_000;
const PERSONALITY_CHARS = 600;
const SEEN_LIMIT = 500;

export interface AgentActDeps {
  bus: () => SwitchboardBus | null | undefined;
  now?: () => number;
  logger?: Logger;
  sleep: Pick<AgentSleep, 'isAsleep' | 'set'>;
  quietSaves: Pick<QuietSaves, 'list'>;
  presence: { snapshot(now?: number): PresenceSnapshot };
  /** The avatar's name; null when there is no such avatar. */
  avatarName: (avatarId: string) => string | null;
  /** Its personality text (no scene tags) and idle habits. */
  persona: (avatarId: string) => string;
  habits: (avatarId: string) => string;
  /** The place id the avatar is in, or "next-door" for the offscreen place. */
  placeOf: (avatarId: string) => string;
  /** Idle restlessness; null when the idle life is switched off. */
  restlessness: () => Restlessness | null;
  /** A voice turn is running for the avatar, or Kevin talked with it in the last two minutes. */
  conversationActive: (avatarId: string) => boolean;
  pursuits: {
    isRunning(avatarId: string): boolean;
    offers(): PursuitOffer[];
    start(avatarId: string, stationId: string): { ok: boolean; reason?: string };
    interrupt(avatarId: string, reason?: string): boolean;
  };
  /** Queue an update for the avatar's inbox (mirror.noteQueued, or notifyAvatar when it has no mirror). */
  say: (avatarId: string, text: string, urgent: boolean, source: string) => void;
  /** The avatar's own chat client, or null when its voice is not ready. */
  chatFor: (avatarId: string) => ChatClient | null;
  /** The memory brief for the avatar, as prompt text; null when there is none. */
  brief: (avatarId: string) => Promise<string | null>;
  llmGate: LlmGate;
  tools: {
    list(): RegisteredTool[];
    execute(toolId: string, params: unknown, context?: ToolContext): Promise<ToolExecutionResult>;
  };
  approvals: {
    request(
      tool: RegisteredTool,
      params: unknown,
      avatarId?: string,
      options?: { ttlMs?: number },
    ): Promise<PendingApproval>;
    on(event: 'outcome', listener: (outcome: ApprovalOutcome) => void): unknown;
    off(event: 'outcome', listener: (outcome: ApprovalOutcome) => void): unknown;
  };
  nextDoor: { tryAvatar(avatarId: string): { moved: boolean; reason?: string } };
  thinkBusyWaitMs?: number;
  thinkTimeoutMs?: number;
}

interface ActRequest {
  txnId: string;
  kind: string;
  avatarId: string;
  args: Record<string, unknown>;
  deadline: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** ISO time with the local offset, e.g. 2026-11-26T07:30:00+08:00. */
export function localIso(date: Date): string {
  const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

export class AgentActHandler {
  private unsubscribe: (() => void) | null = null;
  private readonly seen = new Set<string>();
  /** Running thinks by avatar, so a live voice turn can stop them. */
  private readonly thinking = new Map<string, Set<AbortController>>();

  constructor(private readonly deps: AgentActDeps) {}

  start(): void {
    if (this.unsubscribe) return;
    const bus = this.deps.bus();
    if (!bus) return;
    this.unsubscribe = bus.subscribe({
      actor: 'service:app',
      to: ['service:app'],
      types: ['agent.act'],
      onEvent: (event) => void this.handle(event),
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const set of this.thinking.values())
      for (const controller of set) controller.abort(new DOMException('closing', 'AbortError'));
  }

  /** A real voice turn started for the avatar: its running thinks stop (they answer "busy"). */
  interruptThinking(avatarId: string): void {
    for (const controller of this.thinking.get(avatarId) ?? [])
      controller.abort(new DOMException('conversation', 'AbortError'));
  }

  /** Handles one event. Never throws or rejects; resolves when the answer is published. */
  async handle(event: SwitchboardEvent): Promise<void> {
    const { logger } = this.deps;
    const now = this.deps.now ?? Date.now;
    const txnId = event.txn?.id;
    const payload = asRecord(event.payload);
    if (!txnId) {
      logger?.warn('Agent act without a transaction id ignored', { id: event.id });
      return;
    }
    if (this.seen.has(txnId)) {
      logger?.debug?.('Agent act seen before, ignored', { txn: txnId });
      return;
    }
    this.seen.add(txnId);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);

    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    const avatarId = typeof payload.avatarId === 'string' ? payload.avatarId : '';
    const deadline = event.txn?.deadline ? Date.parse(event.txn.deadline) : Number.NaN;
    const request: ActRequest = {
      txnId,
      kind,
      avatarId,
      args: asRecord(payload.args),
      deadline: Number.isNaN(deadline) ? null : deadline,
    };
    const startedAt = now();
    let result: { ok: true; result: unknown } | { ok: false; error: string; code: ActCode };
    try {
      result = { ok: true, result: await this.run(request) };
    } catch (error) {
      if (error instanceof ActError) result = { ok: false, error: error.message, code: error.code };
      else
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'failed',
        };
    }
    logger?.info(
      `Agent act ${kind || '(none)'} for ${avatarId || '(none)'} -> ${result.ok ? 'ok' : 'failed'} (${now() - startedAt} ms)`,
      {
        txn: txnId,
        ...(result.ok ? {} : { code: result.code, error: clip(result.error, 200) }),
      },
    );
    this.answer(txnId, result);
  }

  private answer(
    txnId: string,
    result: { ok: true; result: unknown } | { ok: false; error: string; code: ActCode },
  ): void {
    try {
      this.deps.bus()?.publish({
        type: 'agent.act.result',
        producer: { kind: 'service', id: 'app' },
        to: ['service:workflows'],
        audience: 'private',
        txn: { id: txnId, state: result.ok ? 'done' : 'failed' },
        payload: result.ok
          ? { ok: true, result: result.result }
          : { ok: false, error: result.error, code: result.code },
      });
    } catch (error) {
      this.deps.logger?.warn('Agent act answer could not be published', {
        txn: txnId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async run(request: ActRequest): Promise<unknown> {
    if (!(ACT_KINDS as readonly string[]).includes(request.kind))
      throw new ActError('bad_args', `Unknown act kind "${request.kind}".`);
    if (!request.avatarId || this.deps.avatarName(request.avatarId) === null)
      throw new ActError('bad_args', `Unknown avatar "${request.avatarId}".`);
    switch (request.kind as ActKind) {
      case 'context':
        return this.context(request.avatarId);
      case 'think':
        return this.think(request);
      case 'say':
        return this.say(request);
      case 'tool':
        return this.tool(request);
      case 'ask':
        return this.ask(request);
      case 'start_pursuit':
        return this.startPursuit(request);
      case 'return_home':
        return this.returnHome(request.avatarId);
      case 'sleep_state':
        return this.sleepState(request);
    }
  }

  private context(avatarId: string): Record<string, unknown> {
    const { deps } = this;
    const now = deps.now?.() ?? Date.now();
    const date = new Date(now);
    const snap = deps.presence.snapshot(now);
    const level = deps.restlessness();
    const offers = deps.pursuits
      .offers()
      .filter((offer) => offer.characters === 'all' || offer.characters.includes(avatarId))
      .map((offer) => ({ stationId: offer.stationId, label: offer.objectName }));
    return {
      avatarName: deps.avatarName(avatarId),
      place: deps.placeOf(avatarId),
      localTime: localIso(date),
      hour: date.getHours(),
      voicePhase: snap.voicePhase,
      conversationActive: deps.conversationActive(avatarId),
      secondsSinceKevinSpoke: snap.secondsSinceUserSpoke,
      secondsSinceAvatarSpoke: snap.secondsSinceAssistantSpoke,
      secondsSinceFaceSeen: snap.secondsSinceFaceSeen,
      doNotDisturb: snap.doNotDisturb,
      pursuitRunning: deps.pursuits.isRunning(avatarId),
      pursuitOffers: offers,
      restlessness: level,
      quietSaves: deps.quietSaves.list(avatarId),
      asleep: deps.sleep.isAsleep(avatarId),
      personality: clip(deps.persona(avatarId).replace(/\s+/g, ' ').trim(), PERSONALITY_CHARS),
      idleHabits: deps.habits(avatarId),
    };
  }

  private say(request: ActRequest): { queued: true } {
    const text = typeof request.args.text === 'string' ? request.args.text.trim() : '';
    if (!text) throw new ActError('bad_args', 'say needs "text".');
    const source =
      typeof request.args.source === 'string' && request.args.source.trim()
        ? request.args.source.trim()
        : 'own thoughts';
    this.deps.say(request.avatarId, text, request.args.urgent === true, source);
    return { queued: true };
  }

  /** Wait while a live conversation is going, up to the limit. */
  private async waitForQuiet(avatarId: string): Promise<boolean> {
    const limit = this.deps.thinkBusyWaitMs ?? THINK_BUSY_WAIT_MS;
    const started = Date.now();
    while (this.deps.conversationActive(avatarId)) {
      if (Date.now() - started >= limit) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(10, limit / 10))));
    }
    return true;
  }

  private async think(
    request: ActRequest,
  ): Promise<{ text: string; toolCalls: Array<{ name: string; ok: boolean }> }> {
    const { deps } = this;
    const { avatarId, args } = request;
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) throw new ActError('bad_args', 'think needs a "prompt".');
    const toolsMode = args.tools === 'safe' ? 'safe' : 'none';
    if (args.tools !== undefined && args.tools !== 'safe' && args.tools !== 'none')
      throw new ActError('bad_args', 'tools must be "none" or "safe".');
    const chat = deps.chatFor(avatarId);
    if (!chat) throw new ActError('failed', "The avatar's voice is not ready.");
    if (!(await this.waitForQuiet(avatarId)))
      throw new ActError('busy', 'Kevin is talking with this avatar.');

    const controller = new AbortController();
    const set = this.thinking.get(avatarId) ?? new Set<AbortController>();
    set.add(controller);
    this.thinking.set(avatarId, set);
    const timer = setTimeout(
      () => controller.abort(new DOMException('The think timed out.', 'TimeoutError')),
      deps.thinkTimeoutMs ?? THINK_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      const name = deps.avatarName(avatarId) ?? avatarId;
      const brief = await deps.brief(avatarId).catch(() => null);
      const extra = typeof args.system === 'string' ? args.system.trim() : '';
      const system = [
        deps.persona(avatarId).trim(),
        brief?.trim() ?? '',
        `You are ${name}. This is your own time: nobody is talking to you right now. Everything you write is for yourself or for the program that asked. Write in the first person, as plain text with no markdown and no emoji. Follow the answer format a question asks for exactly.`,
        extra,
      ]
        .filter(Boolean)
        .join('\n\n');
      let calls = 0;
      const llm = new PursuitLlm({
        chat: () => chat,
        gate: deps.llmGate,
        system: () => system,
        execute: (toolId, params) => deps.tools.execute(toolId, params, { avatarId }),
        allowToolCall: () => (calls < THINK_MAX_TOOL_CALLS ? ((calls += 1), true) : false),
      });
      if (toolsMode === 'none')
        return { text: await llm.ask(prompt, controller.signal), toolCalls: [] };
      const safe = deps.tools
        .list()
        .filter((tool) => tool.confirmationLevel === 'none' || tool.confirmationLevel === 'notify');
      const { text, results } = await llm.useTools(
        prompt,
        safe,
        THINK_MAX_TOOL_CALLS + 1,
        controller.signal,
      );
      return { text, toolCalls: results.map((round) => ({ name: round.name, ok: round.ok })) };
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason as { message?: string } | undefined;
        if (reason?.message === 'conversation')
          throw new ActError('busy', 'Kevin started talking with this avatar.');
        throw new ActError('failed', reason?.message ?? 'The think was stopped.');
      }
      throw new ActError('failed', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      set.delete(controller);
      if (set.size === 0) this.thinking.delete(avatarId);
    }
  }

  /** The approval's outcome, waiting until the deadline. Null when nobody answered in time. */
  private waitForOutcome(
    approvalId: string,
    deadline: number | null,
  ): Promise<ApprovalOutcome | null> {
    const { approvals } = this.deps;
    const now = this.deps.now ?? Date.now;
    const waitMs = Math.max(1000, (deadline ?? now() + DEFAULT_APPROVAL_WAIT_MS) - now());
    return new Promise((resolve) => {
      const done = (outcome: ApprovalOutcome | null): void => {
        clearTimeout(timer);
        approvals.off('outcome', onOutcome);
        resolve(outcome);
      };
      const onOutcome = (outcome: ApprovalOutcome): void => {
        if (outcome.approval.id === approvalId) done(outcome);
      };
      const timer = setTimeout(() => done(null), Math.min(waitMs, 2_000_000_000));
      timer.unref?.();
      approvals.on('outcome', onOutcome);
    });
  }

  private ttlFor(request: ActRequest): number {
    const now = (this.deps.now ?? Date.now)();
    return Math.max(60_000, (request.deadline ?? now + DEFAULT_APPROVAL_WAIT_MS) - now);
  }

  private async tool(
    request: ActRequest,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const { deps } = this;
    const name = typeof request.args.name === 'string' ? request.args.name : '';
    if (!name) throw new ActError('bad_args', 'tool needs a "name".');
    const params = request.args.params ?? {};
    const tool = deps.tools.list().find((candidate) => candidate.toolName === name);
    if (!tool) throw new ActError('bad_args', `There is no tool called ${name}.`);
    if (tool.confirmationLevel === 'block')
      throw new ActError('refused', `The tool ${name} is not allowed to run.`);
    if (tool.confirmationLevel === 'confirm') {
      const approval = await deps.approvals.request(tool, params, request.avatarId, {
        ttlMs: this.ttlFor(request),
      });
      const outcome = await this.waitForOutcome(approval.id, request.deadline);
      if (!outcome) return { ok: false, error: 'Kevin did not answer in time.' };
      if (outcome.decision === 'declined') throw new ActError('refused', 'Kevin declined.');
      if (outcome.decision === 'expired')
        return { ok: false, error: 'Kevin did not answer in time.' };
      return outcome.ok
        ? { ok: true, data: outcome.result }
        : { ok: false, error: outcome.result ?? 'The tool failed.' };
    }
    const executed = await deps.tools.execute(tool.id, params, { avatarId: request.avatarId });
    return executed.success
      ? { ok: true, data: executed.data }
      : { ok: false, error: executed.error ?? 'The tool failed.' };
  }

  private async ask(request: ActRequest): Promise<{ approved: boolean; expired?: boolean }> {
    const question = typeof request.args.question === 'string' ? request.args.question.trim() : '';
    if (!question) throw new ActError('bad_args', 'ask needs a "question".');
    const detail = typeof request.args.detail === 'string' ? request.args.detail.trim() : '';
    const name = this.deps.avatarName(request.avatarId) ?? request.avatarId;
    const approval = await this.deps.approvals.request(
      createQuestionTool(name),
      { question, ...(detail ? { detail } : {}) },
      request.avatarId,
      { ttlMs: this.ttlFor(request) },
    );
    const outcome = await this.waitForOutcome(approval.id, request.deadline);
    if (!outcome || outcome.decision === 'expired') return { approved: false, expired: true };
    return { approved: outcome.decision === 'approved' };
  }

  private startPursuit(request: ActRequest): { ok: boolean; reason?: string } {
    const { pursuits } = this.deps;
    const { avatarId } = request;
    let stationId = typeof request.args.stationId === 'string' ? request.args.stationId : '';
    if (!stationId) {
      const offer = pursuits
        .offers()
        .find(
          (candidate) => candidate.characters === 'all' || candidate.characters.includes(avatarId),
        );
      if (!offer) return { ok: false, reason: 'nothing to read here' };
      stationId = offer.stationId;
    }
    return pursuits.start(avatarId, stationId);
  }

  private returnHome(avatarId: string): { moved: boolean; reason?: string } {
    const result = this.deps.nextDoor.tryAvatar(avatarId);
    return result.moved
      ? { moved: true }
      : { moved: false, ...(result.reason ? { reason: result.reason } : {}) };
  }

  private sleepState(request: ActRequest): { ok: true } {
    if (typeof request.args.asleep !== 'boolean')
      throw new ActError('bad_args', 'sleep_state needs "asleep" (true or false).');
    const reason = typeof request.args.reason === 'string' ? request.args.reason : undefined;
    this.deps.sleep.set(request.avatarId, request.args.asleep, reason);
    if (request.args.asleep) {
      // A sleeping avatar stops reading and any thinking in progress.
      this.deps.pursuits.interrupt(request.avatarId, 'asleep');
    }
    return { ok: true };
  }
}
