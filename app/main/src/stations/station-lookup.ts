/**
 * A reading station as ONE tool for the conversation model.
 *
 * Why: a small local model (a 4B Gemma) offered 20+ tools at once, twelve of them the papers library's, never
 * called any. So the conversation sees `go_to_bookshelf` with a single `question` argument instead. Running it:
 * the voice makes the usual station trip around it (the lookup tool is shaped like a station tool, so
 * `StationTrips.begin` walks the avatar exactly as for any station tool), and this class runs a short, focused
 * tool-calling loop with ONLY that station's tools on the same chat client. The summary it returns is the tool
 * result, which the conversation model then speaks in character.
 *
 * Only stations that hold an MCP server, are not `pursuit: 'none'` and have `trip: 'all'` get this treatment.
 * Home Assistant panels (trip 'writes', pursuit 'none') and built-in tools keep being offered one by one.
 * `STATION_SINGLE_TOOL=0` turns the whole thing off.
 *
 * No Electron imports. The registry, the tool executor and the logger come in from outside.
 */
import type { ChatClient } from '../local-voice/voice-engines.js';
import { findPreset } from '../mcp/presets.js';
import { LlmGate, PursuitLlm, clip, resultText, type ToolRound } from '../pursuits/pursuit-llm.js';
import type { RegisteredTool, ToolContext, ToolExecutionResult } from '../tools/tool-registry.js';
import type { StationRegistry } from './station-registry.js';
import type { Station } from '../shared/stations/types.js';

/** Tool calls the focused lookup may make. */
export const LOOKUP_MAX_TOOL_CALLS = 4;
/** Model rounds: up to three that may call tools, then one with no tools that has to answer. */
export const LOOKUP_ROUNDS = 4;
/** The whole lookup (model and tools) is cut off after this long. */
export const LOOKUP_TIMEOUT_MS = 60_000;
/** Characters of the tool results handed to the model in the fallback summary. */
const FALLBACK_RESULT_CHARS = 5000;
/** How many tool names the description lists. */
const NAMES_LISTED = 8;

type LookupStations = Pick<StationRegistry, 'stationForTool' | 'labelsFor' | 'serverNameFor'>;

export interface StationLookupOptions {
  stations: LookupStations;
  tools: {
    execute(toolId: string, params: unknown, context?: ToolContext): Promise<ToolExecutionResult>;
  };
  /** Whether stations are offered as one tool. Read at every turn. Default: env STATION_SINGLE_TOOL is not '0'. */
  enabled?: () => boolean;
  timeoutMs?: number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

/** What a lookup tool stands for. */
interface Lookup {
  station: Station;
  /** The station's tools the focused loop may call (no approval needed). */
  tools: RegisteredTool[];
  serverName: string;
  objectName: string;
}

/** A tool name safe for a model: lowercase letters, digits and underscores. */
export function lookupToolName(objectId: string, taken: Set<string>): string {
  const base = `go_to_${
    objectId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'station'
  }`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}

/**
 * The call to make when the model made none: the first tool that has no required argument and whose name starts
 * with "latest", else with "list" (DAIR: `latest_papers_of_the_week`). Null when there is no such tool.
 */
export function defaultLookupTool(tools: RegisteredTool[]): RegisteredTool | null {
  const noArguments = tools.filter((tool) => (tool.inputSchema.required ?? []).length === 0);
  return (
    noArguments.find((tool) => tool.toolName.startsWith('latest')) ??
    noArguments.find((tool) => tool.toolName.startsWith('list')) ??
    null
  );
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

export class StationLookup {
  /** The lookup tools offered so far (by object), so `run` can find what one stands for. */
  private readonly lookups = new WeakMap<RegisteredTool, Lookup>();

  constructor(private readonly options: StationLookupOptions) {}

  private enabled(): boolean {
    return this.options.enabled ? this.options.enabled() : process.env.STATION_SINGLE_TOOL !== '0';
  }

  /** Whether `tool` is a lookup tool made by `offer`. */
  isLookup(tool: RegisteredTool | undefined): boolean {
    return tool !== undefined && this.lookups.has(tool);
  }

  /**
   * The tools to offer the conversation: the given ones, except that the tools of every reading station are
   * replaced by one lookup tool for that station. Unchanged when switched off.
   */
  offer(tools: RegisteredTool[]): RegisteredTool[] {
    if (!this.enabled()) return tools;
    const groups = new Map<string, { station: Station; inner: RegisteredTool[] }>();
    for (const tool of tools) {
      // A tool that needs approval stays on its own: the lookup could not ask Kevin.
      if (tool.confirmationLevel !== 'none' && tool.confirmationLevel !== 'notify') continue;
      const station = this.options.stations.stationForTool(tool);
      if (
        !station ||
        station.source.kind !== 'mcp' ||
        station.pursuit === 'none' ||
        station.trip !== 'all'
      )
        continue;
      const group = groups.get(station.id) ?? { station, inner: [] };
      group.inner.push(tool);
      groups.set(station.id, group);
    }
    if (groups.size === 0) return tools;
    const hidden = new Set([...groups.values()].flatMap((group) => group.inner));
    const kept = tools.filter((tool) => !hidden.has(tool));
    const taken = new Set(kept.map((tool) => tool.toolName));
    for (const { station, inner } of groups.values()) {
      const lookup = this.build(station, inner, taken);
      taken.add(lookup.toolName);
      kept.push(lookup);
    }
    return kept;
  }

  /** The lookup tool for one station. It carries the real server id, so the station trip code treats it as a station tool. */
  private build(station: Station, inner: RegisteredTool[], taken: Set<string>): RegisteredTool {
    const { stations } = this.options;
    const { roomName, objectName } = stations.labelsFor(station);
    const serverName = stations.serverNameFor(station) ?? 'its library';
    const preset =
      station.source.kind === 'mcp' && station.source.preset
        ? findPreset(station.source.preset)
        : undefined;
    // The first sentence of the preset's own description says what the library holds.
    const blurb = preset?.description.split(/\.\s/)[0]?.replace(/\.$/, '');
    const names = inner.slice(0, NAMES_LISTED).map((tool) => tool.toolName.replace(/_/g, ' '));
    const more = inner.length > NAMES_LISTED ? ` and ${inner.length - NAMES_LISTED} more` : '';
    const tool: RegisteredTool = {
      id: `station-lookup:${station.id}`,
      serverId: inner[0].serverId,
      toolName: lookupToolName(station.objectId, taken),
      description:
        `Walk to the ${objectName} in the ${roomName} (where you ${station.verb}) and look something up in ${serverName}` +
        `${blurb ? `, ${lowerFirst(blurb)}` : ''}. It can: ${names.join(', ')}${more}. ` +
        `Use this whenever Kevin asks about what it holds or what is new there. Say in "question" what to find out.`,
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'What to find out, in a few words, for example "the latest AI papers".',
          },
        },
        required: ['question'],
      },
      enabled: true,
      confirmationLevel: 'none',
      readOnly: true,
      spokenNotice: `Let me check the ${objectName}.`,
      describeCall: (params) => questionOf(params),
      // Never called: the voice runs a lookup tool through `run`, which needs the chat client and the signal.
      execute: () => Promise.reject(new Error('A station lookup runs through StationLookup.run.')),
    };
    this.lookups.set(tool, { station, tools: inner, serverName, objectName });
    return tool;
  }

  /**
   * Runs the focused lookup for `tool` (made by `offer`) and returns the summary for the conversation model.
   * Never returns empty text: with no tool call from the model, the default call is made for it.
   */
  async run(
    avatarId: string,
    tool: RegisteredTool,
    params: unknown,
    context: { chat: ChatClient; signal: AbortSignal },
  ): Promise<string> {
    const lookup = this.lookups.get(tool);
    if (!lookup) throw new Error(`${tool.toolName} is not a station lookup.`);
    const { logger } = this.options;
    const question = questionOf(params);
    const startedAt = Date.now();
    logger?.info('Stations: lookup start', {
      avatarId,
      stationId: lookup.station.id,
      tool: tool.toolName,
      question: clip(question, 200),
      tools: lookup.tools.length,
    });

    // Cut off after the time limit; the caller's signal (the turn was cancelled) still wins and rethrows.
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? LOOKUP_TIMEOUT_MS),
    ]);
    const results: ToolRound[] = [];
    let calls = 0;
    const logCall = (call: {
      name: string;
      arguments: string;
      durationMs: number;
      ok: boolean;
      resultLength: number;
      error?: string;
    }): void => {
      logger?.info('Stations: lookup tool call', {
        avatarId,
        stationId: lookup.station.id,
        tool: call.name,
        args: clip(call.arguments, 300),
        durationMs: call.durationMs,
        ok: call.ok,
        resultLength: call.resultLength,
        ...(call.error ? { error: clip(call.error, 200) } : {}),
      });
    };
    const llm = new PursuitLlm({
      chat: () => context.chat,
      // The conversation turn already holds the model server's slot; the lookup is part of it, so no queue.
      gate: new LlmGate(Number.MAX_SAFE_INTEGER),
      system: () => lookupGuidance(lookup),
      execute: (toolId, toolParams) => this.options.tools.execute(toolId, toolParams, { avatarId }),
      allowToolCall: () => (calls < LOOKUP_MAX_TOOL_CALLS ? ((calls += 1), true) : false),
      onToolCall: logCall,
    });

    let text = '';
    try {
      text = (
        await llm.useTools(`Question: ${question}`, lookup.tools, LOOKUP_ROUNDS, signal, results)
      ).text.trim();
    } catch (error) {
      if (context.signal.aborted) throw error;
      // The time limit or a model failure: go on with what the tools returned so far.
      logger?.warn('Stations: lookup model call failed', {
        avatarId,
        stationId: lookup.station.id,
        message: error instanceof Error ? error.message : String(error),
        timedOut: signal.aborted,
      });
    }

    // The model called no tool at all (the small model ignoring its tools): make the obvious call for it.
    if (results.length === 0) {
      const fallback = defaultLookupTool(lookup.tools);
      logger?.info('Stations: lookup made no tool call', {
        avatarId,
        stationId: lookup.station.id,
        fallback: fallback?.toolName ?? null,
      });
      if (fallback) {
        const result = await this.callFallback(avatarId, fallback, logCall);
        results.push(result);
        text = await this.summarise(llm, question, result, context);
      }
    }

    const usable = results.filter((result) => result.ok);
    let answer = text;
    if (!answer && usable.length > 0)
      answer = clip(usable.map((result) => result.text).join('\n\n'), FALLBACK_RESULT_CHARS);
    if (!answer)
      answer =
        results.length > 0
          ? `The ${lookup.objectName} lookup failed: ${clip(results[0].text, 300)}`
          : `Nothing could be looked up at the ${lookup.objectName}.`;
    logger?.info('Stations: lookup end', {
      avatarId,
      stationId: lookup.station.id,
      durationMs: Date.now() - startedAt,
      toolCalls: results.length,
      ok: usable.length > 0,
      resultLength: answer.length,
    });
    return answer;
  }

  /** The default call, with no arguments. */
  private async callFallback(
    avatarId: string,
    tool: RegisteredTool,
    log: (call: {
      name: string;
      arguments: string;
      durationMs: number;
      ok: boolean;
      resultLength: number;
      error?: string;
    }) => void,
  ): Promise<ToolRound> {
    const startedAt = Date.now();
    let round: ToolRound;
    try {
      const result = await this.options.tools.execute(tool.id, {}, { avatarId });
      round = result.success
        ? { name: tool.toolName, arguments: '{}', text: resultText(result.data), ok: true }
        : {
            name: tool.toolName,
            arguments: '{}',
            text: JSON.stringify({ error: result.error ?? 'The tool failed.' }),
            ok: false,
          };
    } catch (error) {
      round = {
        name: tool.toolName,
        arguments: '{}',
        text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        ok: false,
      };
    }
    log({
      name: round.name,
      arguments: round.arguments,
      durationMs: Date.now() - startedAt,
      ok: round.ok,
      resultLength: round.text.length,
    });
    return round;
  }

  /** One model call that turns a tool result into the answer; empty when it fails (the caller then uses the raw result). */
  private async summarise(
    llm: PursuitLlm,
    question: string,
    result: ToolRound,
    context: { signal: AbortSignal },
  ): Promise<string> {
    if (!result.ok) return '';
    try {
      const prompt = `Question: ${question}\n\nWhat the library returned:\n${clip(result.text, FALLBACK_RESULT_CHARS)}\n\nAnswer the question from this, briefly, with titles and links.`;
      return (
        await llm.ask(
          prompt,
          AbortSignal.any([
            context.signal,
            AbortSignal.timeout(this.options.timeoutMs ?? LOOKUP_TIMEOUT_MS),
          ]),
        )
      ).trim();
    } catch (error) {
      if (context.signal.aborted) throw error;
      return '';
    }
  }
}

function questionOf(params: unknown): string {
  const question =
    params && typeof params === 'object' ? (params as { question?: unknown }).question : undefined;
  return typeof question === 'string' && question.trim() ? question.trim() : 'What is new?';
}

/** The system message of the focused loop: short, because the model is small. */
function lookupGuidance(lookup: Lookup): string {
  return (
    `You are looking something up in ${lookup.serverName}, at the ${lookup.objectName}. ` +
    'Find the answer to the question by calling the tools now; do not answer from memory. ' +
    'When you have the results, reply with a concise factual summary of at most about 120 words, with the titles and links of what you found. ' +
    'Plain text, no preamble. If the tools found nothing, say so.'
  );
}
