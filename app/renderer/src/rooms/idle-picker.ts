/**
 * Who acts next when several avatars share a room (docs/features/multi-avatar-movement.md, section 6).
 * Pure: the director passes what it knows about each avatar and a small `state` the picker advances.
 * Round-robin over a rotation in which Echo appears twice as often as every other avatar
 * (echo, a, echo, b, ...), skipping avatars that are busy, speaking or acted recently.
 */

export const ECHO_ID = 'echo';
/** An avatar that acted less than this long ago (ms) is skipped. */
export const IDLE_ACTOR_COOLDOWN_MS = 20_000;

export interface IdleCandidate {
  id: string;
  /** Its executor is working on something. */
  busy: boolean;
  /** Its voice is playing. */
  speaking: boolean;
  /** When it last did an idle action (ms, same clock as `now`); 0 or undefined when never. */
  lastActedAt?: number;
}

export interface IdlePickerState {
  /** Position in the rotation; advanced by every pick. */
  turn: number;
}

export interface IdlePickerOptions {
  cooldownMs?: number;
  /** Picks among the eligible avatars at random instead of in rotation (tests inject one). */
  rng?: () => number;
}

export function createIdlePickerState(): IdlePickerState {
  return { turn: 0 };
}

/** echo, a, echo, b, ... for candidates in their given order; Echo leads, others keep their order. */
export function idleRotation(ids: readonly string[]): string[] {
  const others = ids.filter((id) => id !== ECHO_ID);
  if (others.length === 0) return ids.includes(ECHO_ID) ? [ECHO_ID] : [];
  const hasEcho = ids.includes(ECHO_ID);
  if (!hasEcho) return others;
  return others.flatMap((id) => [ECHO_ID, id]);
}

/** The avatar that acts now, or null when nobody is eligible. */
export function pickIdleActor(
  candidates: readonly IdleCandidate[],
  now: number,
  state: IdlePickerState,
  options: IdlePickerOptions = {},
): string | null {
  const cooldown = options.cooldownMs ?? IDLE_ACTOR_COOLDOWN_MS;
  // Alone in the room, Echo acts on her own timing: the cooldown is for taking turns.
  const alone = candidates.length === 1;
  const eligible = new Set(
    candidates
      .filter(
        (c) =>
          !c.busy && !c.speaking && (alone || !c.lastActedAt || now - c.lastActedAt >= cooldown),
      )
      .map((c) => c.id),
  );
  if (eligible.size === 0) return null;
  if (options.rng) {
    const ids = [...eligible];
    const weighted = ids.flatMap((id) => (id === ECHO_ID ? [id, id] : [id]));
    state.turn += 1;
    return (
      weighted[Math.min(weighted.length - 1, Math.floor(options.rng() * weighted.length))] ?? null
    );
  }
  const rotation = idleRotation(candidates.map((c) => c.id));
  for (let step = 0; step < rotation.length; step += 1) {
    const index = (state.turn + step) % rotation.length;
    const id = rotation[index];
    if (id !== undefined && eligible.has(id)) {
      state.turn = index + 1;
      return id;
    }
  }
  return null;
}
