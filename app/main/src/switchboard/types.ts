/**
 * The switchboard's event envelope (services/switchboard, API.md), as the app sees it.
 * Addresses are `<kind>:<id>`.
 */

export type ActorKind = 'avatar' | 'person' | 'tool' | 'service' | 'sensor' | 'device' | 'remote';
export type AddressKind = ActorKind | 'scene' | 'cap';
export type Address = `${AddressKind}:${string}`;

export type TxnState = 'open' | 'accepted' | 'waiting' | 'progress' | 'done' | 'failed' | 'cancelled' | 'expired';
export type Audience = 'private' | 'household' | 'shareable';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface SwitchboardProducer {
  kind: ActorKind;
  id: string;
  node?: string;
}

export interface SwitchboardTxn {
  id: string;
  parent?: string;
  root?: string;
  /** Id of the event that caused this one. */
  cause?: string;
  state?: TxnState;
  title?: string;
  /** ISO time. */
  deadline?: string;
}

/** What a caller gives to publish(). The client fills in id and at. */
export interface SwitchboardEventInput {
  id?: string;
  type: string;
  v?: 1;
  at?: string;
  producer: SwitchboardProducer;
  to?: Address[];
  scene?: string;
  txn?: SwitchboardTxn;
  audience?: Audience;
  priority?: Priority;
  expires?: string;
  payload?: Record<string, unknown>;
}

export interface SwitchboardEvent extends SwitchboardEventInput {
  id: string;
  v: 1;
  at: string;
  to: Address[];
  payload: Record<string, unknown>;
}

export interface SwitchboardHealth {
  ok: boolean;
  version?: string;
  node?: string;
  events?: number;
  open_txns?: number;
  clients?: number;
}
