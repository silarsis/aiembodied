/** The status panel's bridge to the switchboard. Types only; shared by preload and renderer. */
export interface SwitchboardOpenTxn {
  id: string;
  title: string | null;
  state: string;
  opened_by: string | null;
  owner: string | null;
  updated_at: string | null;
}

/** One thing an avatar's inbox decided about an event addressed to it. */
export interface SwitchboardDecision {
  /** ISO time of the decision. */
  at: string;
  avatarId: string;
  avatarName: string;
  /** Id of the event it was about. */
  event: string;
  type: string;
  action: string;
  reason: string;
  ms: number;
  fallback: boolean;
  doNotDisturb: boolean;
}

export interface SwitchboardStatus {
  /** False when SWITCHBOARD_ENABLED=0. */
  enabled: boolean;
  /** Live subscription is up. */
  connected: boolean;
  url: string | null;
  /** Null when the switchboard did not answer. */
  openTxns: SwitchboardOpenTxn[] | null;
  /** The latest inbox decisions of the avatars, newest first. Kept in the app, so up even when the switchboard is down. */
  decisions?: SwitchboardDecision[];
}

export interface SwitchboardBridge {
  status(): Promise<SwitchboardStatus>;
}
