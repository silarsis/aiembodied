/** IPC for the approval card: what waits for Kevin, approve, decline, and a push when the list changes. */
import type { ApprovalBroker, ApprovalOutcome } from './approvals.js';
import type { PendingApproval } from '../shared/tools/approvals-types.js';
import type { ApprovalView, ApprovalResultView } from '../shared/tools/approvals-ipc-types.js';

export interface ApprovalsIpcOptions {
  ipcMain: { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void };
  broker: Pick<ApprovalBroker, 'list' | 'approve' | 'decline' | 'on' | 'off'>;
  broadcast: (channel: string, payload: unknown) => void;
}

export function toApprovalView(approval: PendingApproval): ApprovalView {
  const { id, toolName, summary, createdAt, expiresAt, cardOnly, source } = approval;
  return { id, toolName, summary, createdAt, expiresAt, cardOnly, source };
}

export function registerApprovalsIpc(options: ApprovalsIpcOptions): () => void {
  const { ipcMain, broker } = options;
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value) throw new Error('An approval id is required.');
    return value;
  };
  ipcMain.handle('approvals:list', () => broker.list().map(toApprovalView));
  ipcMain.handle('approvals:approve', async (_event, value: unknown) => summarizeOutcome(await broker.approve(id(value), 'card')));
  ipcMain.handle('approvals:decline', (_event, value: unknown) => summarizeOutcome(broker.decline(id(value), 'card')));
  const changed = (list: PendingApproval[]) => options.broadcast('approvals:changed', list.map(toApprovalView));
  broker.on('changed', changed);
  return () => {
    broker.off('changed', changed);
  };
}

function summarizeOutcome(outcome: ApprovalOutcome | null): ApprovalResultView | null {
  return outcome ? { decision: outcome.decision, ok: outcome.ok, result: outcome.result } : null;
}
