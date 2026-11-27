// Types only: shared/ holds what the main process and the renderer both need.

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
