/**
 * The `chat_template_kwargs` sent with every request to a local chat server, so the model
 * answers straight away instead of reasoning first.
 *
 * Most templates (Qwen, Gemma) switch reasoning off with `enable_thinking: false`. Some read
 * another variable and ignore that one, so they get extra kwargs here, keyed by the model id.
 * Don't send those to every model: other templates give the same names other meanings
 * (gpt-oss's `reasoning_effort` takes low/medium/high and has no "none").
 */

interface ModelTemplateKwargs {
  /** Lower-case substring of the model id the request names. */
  match: string;
  kwargs: Record<string, string | number | boolean>;
}

const MODEL_TEMPLATE_KWARGS: readonly ModelTemplateKwargs[] = [
  // Inkling-2-Mini's template defaults to reasoning_effort 0.9 and ignores enable_thinking.
  { match: 'inkling', kwargs: { reasoning_effort: 'none' } },
];

export function chatTemplateKwargs(model: string | undefined): Record<string, unknown> {
  const id = (model ?? '').toLowerCase();
  const extra = MODEL_TEMPLATE_KWARGS.find((entry) => id.includes(entry.match));
  return { enable_thinking: false, ...extra?.kwargs };
}
