/**
 * How many conversations this PC's llama-server holds at once, and how much context each gets.
 * llama-server splits its total context evenly across its slots, so the start script is given
 * the context per slot and multiplies it. The choice is kept in <userData>/local-llm.json (see
 * llm-library.ts); scripts/local-services.mjs reads the same file and applies the same defaults.
 */

export interface LocalLlmSettings {
  /** Conversations at once, one slot each (so each keeps its own prompt cache). */
  slots: number;
  /** Tokens of context each slot gets. */
  contextPerSlot: number;
}

export const DEFAULT_LLM_SLOTS = 2;
export const MAX_LLM_SLOTS = 8;
export const DEFAULT_LLM_CONTEXT_PER_SLOT = 65536;
export const MIN_LLM_CONTEXT_PER_SLOT = 4096;

function whole(value: unknown): number | null {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

/** A slot count from the file or the environment, kept within 1..8; null when it isn't a number. */
export function clampSlots(value: unknown): number | null {
  const number = whole(value);
  return number === null ? null : Math.min(MAX_LLM_SLOTS, Math.max(1, number));
}

/** A per-slot context from the file; at least 4096, null when it isn't a number. */
export function clampContextPerSlot(value: unknown): number | null {
  const number = whole(value);
  return number === null ? null : Math.max(MIN_LLM_CONTEXT_PER_SLOT, number);
}

/**
 * What was saved, else LOCAL_LLM_SLOTS / LOCAL_LLM_CONTEXT, else 2 slots of 64K each.
 * LOCAL_LLM_CONTEXT is the context per slot.
 */
export function resolveLlmSettings(saved: Partial<LocalLlmSettings> | undefined, env: NodeJS.ProcessEnv = process.env): LocalLlmSettings {
  const envContext = whole(env.LOCAL_LLM_CONTEXT);
  return {
    slots: clampSlots(saved?.slots) ?? clampSlots(env.LOCAL_LLM_SLOTS) ?? DEFAULT_LLM_SLOTS,
    contextPerSlot:
      clampContextPerSlot(saved?.contextPerSlot) ?? (envContext !== null && envContext > 0 ? envContext : DEFAULT_LLM_CONTEXT_PER_SLOT),
  };
}
