/**
 * The app's side of the bus: what a subscriber looks like, and the local router that delivers an
 * event the app itself published to its own subscribers when the switchboard cannot (down,
 * disabled). Delivery is queued with setImmediate, so publish() never runs a subscriber inline.
 * Subscribers dedupe by event id, so an event delivered locally and again by a reconnect replay is
 * handled once.
 */
import type { Address, SwitchboardEvent, SwitchboardEventInput } from './types.js';

export interface SwitchboardSubscription {
  /** Who is listening, sent in the hello. */
  actor?: Address | null;
  /** Addresses this subscriber receives events for. */
  to: Address[];
  /** Type globs, such as `home.*`. Default all. */
  types?: string[];
  onEvent: (event: SwitchboardEvent) => void;
}

export interface OpenTxn {
  id: string;
  title?: string | null;
  state: string;
  opened_by?: string | null;
  owner?: string | null;
  updated_at?: string | null;
}

/** What callers use; the same for the real client and for the local-only bus. */
export interface SwitchboardBus {
  publish(event: SwitchboardEventInput): SwitchboardEvent | null;
  /** Returns a function that ends the subscription. */
  subscribe(subscription: SwitchboardSubscription): () => void;
  /** Whether live delivery from the switchboard is working. */
  connected(): boolean;
}

export const DEDUPE_LIMIT = 2000;

/** `*` matches anything; `a.*` matches `a.b` and `a.b.c`; otherwise exact. */
export function matchesType(globs: string[] | undefined, type: string): boolean {
  if (!globs || globs.length === 0) return true;
  return globs.some((glob) => glob === '*' || glob === type || (glob.endsWith('.*') && type.startsWith(glob.slice(0, -1))));
}

export function addressedTo(subscription: Pick<SwitchboardSubscription, 'to'>, event: SwitchboardEvent): boolean {
  return event.to.some((address) => subscription.to.includes(address));
}

/** A set of the last N ids seen. */
export class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly limit = DEDUPE_LIMIT) {}
  /** True if the id is new (and is now remembered). */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string);
    return true;
  }
}

export interface RouterEntry {
  subscription: SwitchboardSubscription;
  seen: RecentIds;
  /** Called by whoever owns the entry to hand an event over once, whatever route it took. */
  deliver: (event: SwitchboardEvent) => void;
}

/** Subscribers of this process, and the loopback delivery to them. */
export class LoopbackRouter {
  private readonly entries = new Set<RouterEntry>();

  add(subscription: SwitchboardSubscription, onError?: (error: unknown) => void): RouterEntry {
    const seen = new RecentIds();
    const entry: RouterEntry = {
      subscription,
      seen,
      deliver: (event) => {
        if (!seen.add(event.id)) return;
        try {
          subscription.onEvent(event);
        } catch (error) {
          onError?.(error);
        }
      },
    };
    this.entries.add(entry);
    return entry;
  }

  remove(entry: RouterEntry): void {
    this.entries.delete(entry);
  }

  /** Queue the event for every matching subscriber for which `eligible` is true. */
  loopback(event: SwitchboardEvent, eligible: (entry: RouterEntry) => boolean = () => true): void {
    for (const entry of this.entries) {
      if (!eligible(entry) || !addressedTo(entry.subscription, event) || !matchesType(entry.subscription.types, event.type)) continue;
      setImmediate(() => entry.deliver(event));
    }
  }
}

/** The bus when the switchboard is disabled: same API, everything stays in this process. */
export class LocalOnlyBus implements SwitchboardBus {
  private readonly router = new LoopbackRouter();

  constructor(private readonly makeId: (time: number) => string, private readonly now: () => number = Date.now) {}

  publish(input: SwitchboardEventInput): SwitchboardEvent | null {
    try {
      const time = this.now();
      const event: SwitchboardEvent = {
        ...input,
        id: input.id ?? this.makeId(time),
        v: 1,
        at: input.at ?? new Date(time).toISOString(),
        to: input.to ?? [],
        payload: input.payload ?? {},
      };
      this.router.loopback(event);
      return event;
    } catch {
      return null;
    }
  }

  subscribe(subscription: SwitchboardSubscription): () => void {
    const entry = this.router.add(subscription);
    return () => this.router.remove(entry);
  }

  connected(): boolean {
    return false;
  }
}
