/** A new desktop room starts in the built-in Studio flat. In its own file because the renderer imports it too. */
export const DEFAULT_DESKTOP_ROOM = 'room:builtin:studio-flat';
/**
 * A new phone room starts on a 2D background (the first built-in one, "Garden terrace", which is also what bija starts
 * with): a phone is a small screen, and the 3D Studio flat is heavy for it.
 */
export const DEFAULT_PHONE_ROOM = 'builtin:garden';

/** The room a new device place draws until Kevin picks one. */
export function defaultRoomFor(kind: 'desktop' | 'phone' | 'browser' | undefined): string {
  return kind === 'phone' ? DEFAULT_PHONE_ROOM : DEFAULT_DESKTOP_ROOM;
}
