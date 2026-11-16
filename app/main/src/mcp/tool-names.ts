/**
 * Names the assistant (LLM) sees for MCP tools.
 * OpenAI-style function names must match ^[a-zA-Z0-9_-]{1,64}$ and be unique across all tools,
 * but MCP servers choose their own names freely, so we clean them up here.
 */

export const MAX_TOOL_NAME_LENGTH = 64;
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAME.test(name);
}

/** Replace every character that is not a letter, digit, underscore or dash with '_' and cut to 64. */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_TOOL_NAME_LENGTH);
  return cleaned || 'tool';
}

/** A short word made from the server name, e.g. 'DAIR Academy papers' becomes 'dair_academy_papers'. */
export function serverSlug(serverName: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/g, '');
  return slug || 'server';
}

/**
 * Pick the name for one tool.
 * 1. The cleaned-up server name, if nobody has it (`taken` holds the names in use).
 * 2. Otherwise `<server slug>__<name>` cut to 64 characters.
 * 3. If even that is taken, add `_2`, `_3`, ... at the end.
 */
export function chooseToolName(originalName: string, serverName: string, taken: ReadonlySet<string>): string {
  const base = sanitizeToolName(originalName);
  if (!taken.has(base)) return base;

  const prefixed = `${serverSlug(serverName)}__${base}`.slice(0, MAX_TOOL_NAME_LENGTH);
  if (!taken.has(prefixed)) return prefixed;

  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = prefixed.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
