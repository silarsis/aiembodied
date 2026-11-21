/**
 * Runs reading sessions, one per avatar at most. A session is started by the character's own choice (the idle
 * director, through IPC `pursuits:start`), walks the body to the station, runs `ReadingPursuit` on the avatar's
 * own conversation model with only that station's tools, and ends when the character is done, hits a bound,
 * times out, or Kevin starts talking with it (`interrupt`).
 *
 * Electron-free: the stations, tools, voices, memory, body and inbox come in from outside.
 */
import type { ChatClient } from '../local-voice/voice-engines.js';
import type { StationRegistry } from '../stations/station-registry.js';
import type { Station } from '../stations/types.js';
import type { StationVisit } from '../stations/station-trips.js';
import type { RegisteredTool, ToolExecutionResult } from '../tools/tool-registry.js';
import { SESSION_TIMEOUT_MS, runPursuit, type PursuitResult } from './pursuit.js';
import { LlmGate, PursuitLlm, clip } from './pursuit-llm.js';
import { MAX_TOOL_CALLS, ReadingPursuit, readingActivity, readingGuidance, type ReadingMemory } from './reading-pursuit.js';
import type { PursuitOffer, ReadingNote, ReadingNoteStore } from './types.js';

type Logger = Pick<Console, 'info' | 'warn'>;

/** What the manager needs from an avatar's voice service. */
export interface PursuitVoice {
  /** The avatar's conversation model client. */
  chat(): ChatClient;
  /** The last lines of its conversations, oldest first. */
  recentLines(count: number): string[];
}

export interface PursuitManagerOptions {
  stations: Pick<StationRegistry, 'get' | 'list' | 'appliesTo' | 'stationForTool' | 'labelsFor' | 'loadLabels' | 'resolveServerId'>;
  tools: { list(): RegisteredTool[]; execute(toolId: string, params: unknown): Promise<ToolExecutionResult> };
  /** The avatar's voice service; null when the voice is not set up yet. */
  voiceFor: (avatarId: string) => PursuitVoice | null;
  /** The avatar's personality text (no scene tags). */
  persona: (avatarId: string) => string;
  habits: (avatarId: string) => string;
  avatarName: (avatarId: string) => string;
  memoryFor?: (avatarId: string) => ReadingMemory | undefined;
  notes: ReadingNoteStore;
  saveToMemory: (note: ReadingNote, avatarName: string) => void;
  /** An update from the avatar itself for its inbox. */
  tell: (avatarId: string, text: string) => void;
  /** Walk the body to the station; null when the avatar stays where it is. */
  visit: (avatarId: string, station: Station) => StationVisit | null;
  /** The set of reading avatars changed. */
  onChanged?: (running: string[]) => void;
  gate?: LlmGate;
  sessionTimeoutMs?: number;
  maxToolCalls?: number;
  logger?: Logger;
}

interface Session {
  controller: AbortController;
  stationId: string;
  done: Promise<PursuitResult>;
}

export class PursuitManager {
  private readonly sessions = new Map<string, Session>();
  private readonly gate: LlmGate;

  constructor(private readonly options: PursuitManagerOptions) {
    this.gate = options.gate ?? new LlmGate(1);
  }

  isRunning(avatarId: string): boolean {
    return this.sessions.has(avatarId);
  }

  running(): string[] {
    return [...this.sessions.keys()];
  }

  /** The tools a reading session may call at a station: the station's own, the ones that need no approval. */
  toolsAt(station: Station): RegisteredTool[] {
    const { stations, tools } = this.options;
    return tools.list().filter((tool) => stations.stationForTool(tool)?.id === station.id && (tool.confirmationLevel === 'none' || tool.confirmationLevel === 'notify'));
  }

  /** The stations that can be read at (they have tools to read with), for the idle director. */
  offers(): PursuitOffer[] {
    const { stations } = this.options;
    return stations
      .list()
      // A Home Assistant panel (`pursuit: 'none'`) is for tool trips only, never something to read at.
      .filter((station) => station.pursuit !== 'none' && this.toolsAt(station).length > 0)
      .map((station) => ({
        stationId: station.id,
        roomId: station.roomId,
        objectId: station.objectId,
        objectName: stations.labelsFor(station).objectName,
        characters: station.characters,
      }));
  }

  /** Starts a session in the background. Resolves at once with whether it began. */
  start(avatarId: string, stationId: string): { ok: boolean; reason?: string } {
    const { stations, logger } = this.options;
    if (this.sessions.has(avatarId)) return { ok: false, reason: 'already reading' };
    const station = stations.get(stationId);
    if (!station) return { ok: false, reason: 'no such station' };
    if (!stations.appliesTo(station, avatarId)) return { ok: false, reason: 'this station is not for this character' };
    if (station.pursuit === 'none') return { ok: false, reason: 'nothing to read here' };
    const tools = this.toolsAt(station);
    if (tools.length === 0) return { ok: false, reason: 'nothing to read with here' };
    const voice = this.options.voiceFor(avatarId);
    if (!voice) return { ok: false, reason: 'the voice is not ready' };

    const controller = new AbortController();
    const done = this.run(avatarId, station, tools, voice, controller);
    this.sessions.set(avatarId, { controller, stationId, done });
    logger?.info('Reading: session started', { avatarId, stationId });
    this.changed();
    return { ok: true };
  }

  /** Kevin started talking with the avatar (or it is stopped by hand): the session ends at once, keeping its notes. */
  interrupt(avatarId: string, reason = 'interrupted'): boolean {
    const session = this.sessions.get(avatarId);
    if (!session) return false;
    session.controller.abort(new DOMException(reason, 'AbortError'));
    return true;
  }

  /** Ends every session and waits for them (the app is closing). */
  async stopAll(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const avatarId of this.running()) this.interrupt(avatarId, 'closing');
    await Promise.allSettled(all.map((session) => session.done));
  }

  /** A session's whole life: the body, the pursuit, and the way back. */
  private async run(avatarId: string, station: Station, tools: RegisteredTool[], voice: PursuitVoice, controller: AbortController): Promise<PursuitResult> {
    const { logger } = this.options;
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('The session timed out.', 'TimeoutError')), this.options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS);
    timer.unref?.();
    let visit: StationVisit | null = null;
    let result: PursuitResult = { end: 'failed', steps: 0, items: 0 };
    try {
      await this.options.stations.loadLabels().catch(() => undefined);
      const objectName = this.options.stations.labelsFor(station).objectName;
      const name = this.options.avatarName(avatarId);
      try {
        visit = this.options.visit(avatarId, station);
      } catch (error) {
        logger?.warn('Reading: the body could not start', { avatarId, message: error instanceof Error ? error.message : String(error) });
      }
      let toolCalls = 0;
      const maxCalls = this.options.maxToolCalls ?? MAX_TOOL_CALLS;
      const llm = new PursuitLlm({
        chat: () => voice.chat(),
        gate: this.gate,
        system: () => [this.options.persona(avatarId).trim(), readingGuidance(name, objectName)].filter(Boolean).join('\n\n'),
        execute: (toolId, params) => this.options.tools.execute(toolId, params),
        allowToolCall: () => (toolCalls < maxCalls ? ((toolCalls += 1), true) : false),
        // Tool calls are logged with the arguments cut short (never a token: tool arguments are what the model chose).
        onToolCall: (call) => logger?.info('Reading: tool call', { avatarId, stationId: station.id, tool: call.name, args: clip(call.arguments, 300), durationMs: call.durationMs, ok: call.ok, resultLength: call.resultLength, ...(call.error ? { error: clip(call.error, 200) } : {}) }),
      });
      const reading = new ReadingPursuit({
        avatarId,
        avatarName: name,
        stationId: station.id,
        objectName,
        llm,
        tools,
        habits: this.options.habits(avatarId),
        recentLines: () => voice.recentLines(8),
        memory: this.options.memoryFor?.(avatarId),
        notes: this.options.notes,
        saveToMemory: (note) => this.options.saveToMemory(note, name),
        tell: (text) => this.options.tell(avatarId, text),
        logger,
      });
      result = await runPursuit(reading, {
        signal,
        onStep: (step) => {
          logger?.info('Reading: step', { avatarId, stationId: station.id, step });
          // The model calls run while the avatar walks over; the walk does not hold them up.
          visit?.activity(readingActivity(step, objectName), step);
        },
      });
    } catch (error) {
      logger?.warn('Reading: the session failed', { avatarId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
      this.sessions.delete(avatarId);
      this.changed();
    }
    logger?.info('Reading: session ended', { avatarId, ...result });
    // The way back (from an errand to another place) happens after the session is over, so it is not held up by it.
    await visit?.settle(result.end === 'finished' || result.end === 'limit').catch((error: unknown) => {
      logger?.warn('Reading: the way back failed', { avatarId, message: error instanceof Error ? error.message : String(error) });
    });
    return result;
  }

  private changed(): void {
    try {
      this.options.onChanged?.(this.running());
    } catch (error) {
      this.options.logger?.warn('Reading: a listener failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
