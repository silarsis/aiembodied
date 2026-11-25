/**
 * What an avatar's inbox saved quietly since the avatar last spoke (at most five, newest last). The life workflow reads
 * them through the `context` act and may decide to mention one. Cleared when the avatar speaks.
 */

export const MAX_QUIET_SAVES = 5;
const SAVE_CHARS = 160;

export class QuietSaves {
  private readonly saves = new Map<string, string[]>();

  add(avatarId: string, text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, SAVE_CHARS);
    if (!clean) return;
    const list = this.saves.get(avatarId) ?? [];
    list.push(clean);
    if (list.length > MAX_QUIET_SAVES) list.splice(0, list.length - MAX_QUIET_SAVES);
    this.saves.set(avatarId, list);
  }

  list(avatarId: string): string[] {
    return [...(this.saves.get(avatarId) ?? [])];
  }

  /** The avatar spoke: older saves are old news. */
  clear(avatarId: string): void {
    this.saves.delete(avatarId);
  }
}
