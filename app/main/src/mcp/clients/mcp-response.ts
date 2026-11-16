import type { MCPToolDefinition } from '../types.js';

/**
 * Helpers shared by all three MCP clients (SSE, Streamable HTTP, stdio).
 * The SDK `Client` is the same for every transport, so turning its answers into our own shapes
 * is done once here instead of in each client.
 */

/** True for a non-null object, so we can look at its keys without casts everywhere. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Convert the SDK's `tools/list` answer into our MCPToolDefinition list.
 * A tool with no name gets an empty name (the manager skips nothing; the server is the authority).
 */
export function normalizeToolList(tools: unknown): MCPToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool: unknown) => {
    const record = isRecord(tool) ? tool : {};
    const name = typeof record.name === 'string' ? record.name : '';
    const description = typeof record.description === 'string' ? record.description : undefined;
    const inputSchema =
      'inputSchema' in record
        ? (record.inputSchema as MCPToolDefinition['inputSchema'])
        : { type: 'object', properties: {} };
    // Tools may say they only read (annotations.readOnlyHint); stations use it to decide on a trip.
    const annotations = isRecord(record.annotations) ? record.annotations : {};
    const readOnlyHint = typeof annotations.readOnlyHint === 'boolean' ? annotations.readOnlyHint : undefined;
    return readOnlyHint === undefined ? { name, description, inputSchema } : { name, description, inputSchema, readOnlyHint };
  });
}

/**
 * Turn a `tools/call` answer into the value we hand back to the caller:
 * - `isError: true` throws an Error carrying the first text item the server sent;
 * - no content gives null;
 * - one text item gives that text;
 * - anything else gives the list of content items (text, image, resource, or unknown).
 */
export function normalizeCallToolResult(response: unknown): unknown {
  const record = isRecord(response) ? response : {};
  const content: unknown[] = Array.isArray(record.content) ? (record.content as unknown[]) : [];

  if (record.isError) {
    let message = 'Tool execution failed';
    for (const item of content) {
      if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
        message = item.text;
        break;
      }
    }
    throw new Error(message);
  }

  if (content.length === 0) return null;

  const first = content[0];
  if (content.length === 1 && isRecord(first) && first.type === 'text' && typeof first.text === 'string') {
    return first.text;
  }

  return content.map((item) => {
    if (!isRecord(item)) return { type: 'unknown', data: String(item) };
    if (item.type === 'text' && 'text' in item) return { type: 'text', text: String(item.text) };
    if (item.type === 'image' && 'data' in item && 'mimeType' in item) {
      return { type: 'image', data: String(item.data), mimeType: String(item.mimeType) };
    }
    if (item.type === 'resource' && 'resource' in item) {
      return { type: 'resource', resource: item.resource as Record<string, unknown> };
    }
    return { type: 'unknown', data: item };
  });
}

/** Build the SDK Client options that forward `tools/list_changed` to a callback. */
export function toolsChangedOptions(onChanged: () => void) {
  return {
    capabilities: {},
    listChanged: { tools: { onChanged } },
  };
}
