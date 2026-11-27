import { ConversationManager } from './conversation-manager.js';
import type { ConversationAppendMessagePayload } from '../shared/conversation/types.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface ConversationIpcOptions {
  handle: HandleIpc;
  conversation: ConversationManager | null;
}

export function registerConversationIpc(options: ConversationIpcOptions): void {
  const { handle, conversation } = options;

  handle('conversation:get-history', () => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.getHistory();
  });
  handle('conversation:append-message', (_event, payload: ConversationAppendMessagePayload) => {
    if (!conversation) {
      throw new Error('Conversation manager is not initialized.');
    }
    return conversation.appendMessage(payload);
  });
  handle(
    'conversation:announce',
    (_event, payload: { note?: string; reply?: string; ts?: number }) => {
      if (!conversation) {
        throw new Error('Conversation manager is not initialized.');
      }
      const ts = typeof payload?.ts === 'number' ? payload.ts : Date.now();
      const messages: Omit<ConversationAppendMessagePayload, 'sessionId'>[] = [];
      if (payload?.note?.trim()) messages.push({ role: 'system', content: payload.note, ts });
      if (payload?.reply?.trim()) messages.push({ role: 'assistant', content: payload.reply, ts });
      return messages.length > 0 ? conversation.appendToRecentSession(messages) : [];
    },
  );
}
