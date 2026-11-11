/**
 * Wire long-term memory into the app: queue every conversation session and message (and, from
 * the local voice, tool calls) for the memory engine, and import the old SQLite history once.
 */
import type { ConversationManager } from '../conversation/conversation-manager.js';
import type { ConversationMessage, ConversationSession } from '../conversation/types.js';
import type { MemoryStore } from '../memory/memory-store.js';
import { MemoryCapture, type CaptureAgent } from './capture.js';
import { MemoryEngineClient } from './client.js';
import { MemoryOutbox } from './outbox.js';
import type { MemoryEngineSettings } from './settings.js';
import { createVoiceMemory, type VoiceMemory } from './voice-memory.js';

type Logger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export interface MemoryEngineRuntime {
  client: MemoryEngineClient;
  outbox: MemoryOutbox;
  capture: MemoryCapture;
  /** The session brief and auto-recall, for the voice pipeline. */
  voice: VoiceMemory;
  /** The session brief and auto-recall for one avatar (the agent name it asks with); no id is the default avatar, `voice`. */
  voiceFor(avatarId?: string): VoiceMemory;
  /** Record a local-voice tool call against the current conversation. */
  recordToolCall(call: { name: string; arguments: unknown; result: string; ok: boolean; at: number }): void;
  stop(): void;
}

export interface SetupMemoryEngineOptions {
  settings: MemoryEngineSettings;
  store: MemoryStore;
  conversations: Pick<ConversationManager, 'on' | 'off' | 'getCurrentSessionId'>;
  logger?: Logger;
  fetchFn?: typeof fetch;
  /** Who the agent is for an avatar id; no id is the default avatar. Defaults to the active VRM model (activeAgent). */
  agentFor?: (avatarId?: string) => CaptureAgent;
}

/** The active character: the VRM model's name, or a generic one. */
export function activeAgent(store: Pick<MemoryStore, 'getActiveVrmModelId' | 'getVrmModel'>): CaptureAgent {
  try {
    const id = store.getActiveVrmModelId();
    const model = id ? store.getVrmModel(id) : null;
    if (model?.name?.trim()) {
      return { name: model.name.trim(), id: model.id };
    }
  } catch {
    // Fall through to the generic name.
  }
  return { name: 'assistant', id: null };
}

export function setupMemoryEngine(options: SetupMemoryEngineOptions): MemoryEngineRuntime | null {
  const { settings, store, conversations, logger } = options;
  if (!settings.enabled) {
    logger?.info('Long-term memory is off (MEMORY_ENABLED=0)');
    return null;
  }

  const client = new MemoryEngineClient({ baseUrl: settings.url, apiToken: settings.apiToken, fetchFn: options.fetchFn });
  const outbox = new MemoryOutbox({ store, client, logger });
  const agentFor = options.agentFor ?? (() => activeAgent(store));
  const capture = new MemoryCapture({ outbox, agent: agentFor, logger });

  const onSession = (session: ConversationSession) => capture.recordSession(session);
  const onMessage = (message: ConversationMessage) => capture.recordMessage(message);
  conversations.on('session-started', onSession);
  conversations.on('message-appended', onMessage);

  try {
    capture.importArchive(store);
  } catch (error) {
    logger?.warn('Could not queue the conversation history for the memory engine', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  outbox.start();
  logger?.info('Long-term memory writes go to the memory engine', { url: settings.url, pending: outbox.status().pending });

  const voices = new Map<string, VoiceMemory>();
  const voiceFor = (avatarId?: string): VoiceMemory => {
    const key = avatarId ?? '';
    let memory = voices.get(key);
    if (!memory) {
      memory = createVoiceMemory({
        client,
        currentSessionId: () => conversations.getCurrentSessionId(),
        agentName: () => agentFor(avatarId).name,
        brief: settings.brief,
        autoRecall: settings.autoRecall,
        logger,
      });
      voices.set(key, memory);
    }
    return memory;
  };
  const voice = voiceFor();

  return {
    client,
    outbox,
    capture,
    voice,
    voiceFor,
    recordToolCall(call) {
      const sessionId = conversations.getCurrentSessionId();
      if (sessionId) {
        capture.recordToolCall({ sessionId, ...call });
      }
    },
    stop() {
      conversations.off('session-started', onSession);
      conversations.off('message-appended', onMessage);
      outbox.stop();
    },
  };
}
