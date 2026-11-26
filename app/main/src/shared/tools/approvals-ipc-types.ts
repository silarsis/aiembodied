// Types only: shared/ holds what the main process and the renderer both need.
import type { PendingApproval } from './approvals-types.js';


/** What the renderer is told about an approval (the params stay in main). */
export type ApprovalView = Pick<PendingApproval, 'id' | 'toolName' | 'summary' | 'createdAt' | 'expiresAt' | 'cardOnly' | 'source'>;


export interface ApprovalResultView {
  decision: string;
  ok?: boolean;
  result?: string;
}


/** The approval card's bridge from the renderer. */
export interface ApprovalsBridge {
  list(): Promise<ApprovalView[]>;
  approve(id: string): Promise<ApprovalResultView | null>;
  decline(id: string): Promise<ApprovalResultView | null>;
  /** The pending list changed. */
  onChanged(listener: (approvals: ApprovalView[]) => void): () => void;
}
