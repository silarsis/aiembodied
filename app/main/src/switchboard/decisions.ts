/** The last few inbox decisions, kept in memory for the Status panel (the journal needs the switchboard). */
export interface DecisionRecord {
  at: string;
  avatarId: string;
  event: string;
  type: string;
  action: string;
  reason: string;
  ms: number;
  fallback: boolean;
  doNotDisturb: boolean;
  /** Which engine decided: 'system-one' (Laya), 'llm', or absent for rules. */
  engine?: string;
}

export class DecisionLog {
  private readonly items: DecisionRecord[] = [];

  constructor(private readonly limit = 10) {}

  record(decision: DecisionRecord): void {
    this.items.push(decision);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  /** Newest first. */
  recent(): DecisionRecord[] {
    return [...this.items].reverse();
  }
}
