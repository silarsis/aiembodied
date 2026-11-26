// Types only: shared/ holds what the main process and the renderer both need.


export interface AvatarProfile {
  id: string;
  name: string;
  /** The body (VRM model) this avatar wears, or null when it has none of its own yet. */
  vrmModelId: string | null;
  /**
   * System prompt for this avatar when no prompt is saved for its own VRM model (avatars sharing
   * Echo's body must not borrow Echo's saved prompt). Set for avatars made from the environment.
   */
  prompt?: string;
}
