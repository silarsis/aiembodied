/**
 * Avatar control tags are written in braces: {move:...}, {go:...}, {sit:...}, {look:...}, {pick:...},
 * {anim:...}, {pose:...}, {static:...}, {stand}, {wait}. They drive the body, never the words, so text that
 * is spoken or passed on to another avatar must not carry them. Whitespace is tidied where a tag was.
 */
export function stripAvatarTags(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
