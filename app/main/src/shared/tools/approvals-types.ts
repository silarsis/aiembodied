// Types only: shared/ holds what the main process and the renderer both need.

export interface PendingApproval {
  id: string;
  toolId: string;
  toolName: string;
  params: unknown;
  /** One line for the card and for Echo, such as "start a coding task in aiembodied: Fix the retry". */
  summary: string;
  createdAt: number;
  expiresAt: number;
  source: 'voice';
  /** Only the card can approve this one. */
  cardOnly: boolean;
  /** Switchboard address of whoever asked. */
  requestedBy: string;
  /** Switchboard addresses of who may decide. */
  approvers: string[];
}
