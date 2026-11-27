import { PushToTalkShortcut } from './push-to-talk.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface TalkIpcOptions {
  handle: HandleIpc;
  pushToTalk: PushToTalkShortcut;
}

export function registerTalkIpc(options: TalkIpcOptions): void {
  const { handle, pushToTalk } = options;

  handle('talk:get-shortcut-status', () => pushToTalk.getStatus());
}
