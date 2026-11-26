// Types only: shared/ holds what the main process and the renderer both need.
import type { JSONSchema } from '../mcp/types.js';


/**
 * OpenAI function definition format for Realtime API.
 */
export interface OpenAIFunction {
  type: 'function';
  name: string;
  description: string;
  parameters: JSONSchema;
}
