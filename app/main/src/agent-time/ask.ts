/**
 * The yes/no question an agent puts to Kevin (the `ask` act, the `ask` flow step) is shown on the normal approval card.
 * The broker takes a tool, so the question is a synthetic one: `confirm` level, card only, never offered to a model, and
 * "run" by a wrapper registry that just says yes when approved.
 */
import type { RegisteredTool, ToolExecutionResult, ToolRegistry } from '../tools/tool-registry.js';

export const QUESTION_TOOL_ID = 'workflows:agent_question';

export function createQuestionTool(avatarName: string): RegisteredTool {
  return {
    id: QUESTION_TOOL_ID,
    serverId: 'workflows',
    toolName: 'agent_question',
    description: 'A question an agent asks Kevin.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
    enabled: true,
    confirmationLevel: 'confirm',
    // Approved on the screen only: a stray spoken "yes" must not answer it.
    cardOnly: () => true,
    describeCall: (params) => {
      const question = String((params as { question?: unknown } | null)?.question ?? '');
      const detail = String((params as { detail?: unknown } | null)?.detail ?? '').trim();
      return `${avatarName} asks: ${question}${detail ? ` (${detail})` : ''}`;
    },
    execute: async () => 'yes',
  };
}

/** The registry as the approval broker sees it: the question tool is answered here, anything else by the real one. */
export function withQuestionTool(registry: Pick<ToolRegistry, 'execute' | 'get'>): Pick<ToolRegistry, 'execute' | 'get'> {
  return {
    get: (id) => (id === QUESTION_TOOL_ID ? createQuestionTool('An agent') : registry.get(id)),
    execute: async (id, params, context): Promise<ToolExecutionResult> =>
      id === QUESTION_TOOL_ID ? { success: true, data: 'yes', durationMs: 0 } : registry.execute(id, params, context),
  };
}
