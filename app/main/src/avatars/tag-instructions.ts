/** How an avatar other than Echo gets its system prompt: persona plus the movement tag instructions. */
import type { AvatarTagInstructions } from './bridge-types.js';

export const MAX_TAG_INSTRUCTIONS_LENGTH = 20_000;

/** Validate what the renderer sent; anything else becomes empty so a bad payload never breaks a prompt. */
export function readTagInstructions(input: unknown): AvatarTagInstructions {
  const read = (value: unknown): string =>
    typeof value === 'string' && value.length <= MAX_TAG_INSTRUCTIONS_LENGTH ? value.trim() : '';
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const result: AvatarTagInstructions = { shared: read(record.shared), moveOnly: read(record.moveOnly) };
  const scene = read(record.scene);
  if (scene) result.scene = scene;
  if (record.sceneFor && typeof record.sceneFor === 'object') {
    const entries = Object.entries(record.sceneFor as Record<string, unknown>)
      .map(([id, text]) => [id, read(text)] as const)
      .filter(([, text]) => text !== '');
    if (entries.length > 0) result.sceneFor = Object.fromEntries(entries);
  }
  return result;
}

export interface ComposeAvatarPromptInput {
  name: string;
  /** The persona prompt (saved for its own model, else the profile's), if any. */
  persona: string | undefined;
  /** True when the avatar wears a body other than Echo's. */
  ownModel: boolean;
  tags: AvatarTagInstructions;
  /** Which avatar this is, to pick its own scene text. */
  avatarId?: string;
}

/** Persona, then a blank line, then the tag instructions that fit its body. Undefined when there is neither. */
export function composeAvatarPrompt({ name, persona, ownModel, tags, avatarId }: ComposeAvatarPromptInput): string | undefined {
  const sceneText = (avatarId ? tags.sceneFor?.[avatarId] : undefined) ?? tags.scene ?? '';
  const baseTagText = ownModel ? tags.moveOnly : tags.shared;
  // The scene text follows the tags; it only exists while live motion is available, so it never stands alone.
  const tagText = baseTagText && sceneText ? `${baseTagText} ${sceneText}` : baseTagText;
  const base = persona?.trim() ?? '';
  if (!tagText) return base || undefined;
  const lead = base || `You are ${name}, an AI character who shares a room with Kevin and Echo.`;
  return `${lead}\n\n${tagText}`;
}
