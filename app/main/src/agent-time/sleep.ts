/**
 * Which avatars are asleep (set by the life workflow through the `sleep_state` act). While asleep an avatar does not
 * wander, read or start idle moves, and its inbox only speaks urgent events (the rest is remembered).
 * Kept in memory: the life workflow keeps its own state and tells the app again when the app restarts.
 */

type Logger = Pick<Console, 'info'>;

export class AgentSleep {
  private readonly asleep = new Map<string, { since: number; reason: string | null }>();
  private readonly listeners = new Set<(asleep: string[]) => void>();

  constructor(
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  isAsleep(avatarId: string): boolean {
    return this.asleep.has(avatarId);
  }

  list(): string[] {
    return [...this.asleep.keys()];
  }

  /** True when the state changed. */
  set(avatarId: string, asleep: boolean, reason?: string | null): boolean {
    if (asleep === this.asleep.has(avatarId)) return false;
    if (asleep) this.asleep.set(avatarId, { since: this.now(), reason: reason ?? null });
    else this.asleep.delete(avatarId);
    this.logger?.info(asleep ? 'Agent fell asleep' : 'Agent woke up', {
      avatarId,
      ...(reason ? { reason } : {}),
    });
    const list = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(list);
      } catch {
        // A listener must not break the others.
      }
    }
    return true;
  }

  /** An avatar that is removed is no longer asleep. */
  forget(avatarId: string): void {
    this.set(avatarId, false);
  }

  onChanged(listener: (asleep: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
