import { SwitchboardClient } from './client.js';
import type { SwitchboardBus } from './bus.js';
import { DecisionLog } from './decisions.js';
import { AvatarRegistry } from '../avatars/avatar-registry.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface SwitchboardIpcOptions {
  handle: HandleIpc;
  switchboardClient: () => SwitchboardClient | null;
  switchboardBus: () => SwitchboardBus | null;
  decisionLog: DecisionLog;
  avatarRegistry: () => AvatarRegistry | null;
}

export function registerSwitchboardIpc(options: SwitchboardIpcOptions): void {
  const {
    handle,
    switchboardClient: getClient,
    switchboardBus: getBus,
    decisionLog,
    avatarRegistry: getRegistry,
  } = options;

  handle('switchboard:status', async () => {
    const switchboardClient = getClient();
    const switchboardBus = getBus();
    const avatarRegistry = getRegistry();
    return {
      enabled: switchboardClient !== null,
      connected: switchboardBus?.connected() === true,
      url: switchboardClient
        ? process.env.SWITCHBOARD_URL?.trim() || 'http://127.0.0.1:8196'
        : null,
      openTxns:
        ((await switchboardClient?.openTxns(20)) ?? null)?.map((t) => ({
          id: t.id,
          title: t.title ?? null,
          state: t.state,
          opened_by: t.opened_by ?? null,
          owner: t.owner ?? null,
          updated_at: t.updated_at ?? null,
        })) ?? null,
      decisions: decisionLog.recent().map((decision) => ({
        ...decision,
        avatarName: avatarRegistry?.get(decision.avatarId)?.name ?? decision.avatarId,
      })),
    };
  });
}
