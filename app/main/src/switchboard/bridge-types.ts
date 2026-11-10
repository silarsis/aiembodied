/** The status panel's bridge to the switchboard. Types only; shared by preload and renderer. */
export interface SwitchboardOpenTxn {
  id: string;
  title: string | null;
  state: string;
  opened_by: string | null;
  owner: string | null;
  updated_at: string | null;
}

export interface SwitchboardStatus {
  /** False when SWITCHBOARD_ENABLED=0. */
  enabled: boolean;
  /** Live subscription is up. */
  connected: boolean;
  url: string | null;
  /** Null when the switchboard did not answer. */
  openTxns: SwitchboardOpenTxn[] | null;
}

export interface SwitchboardBridge {
  status(): Promise<SwitchboardStatus>;
}
