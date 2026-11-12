/** `Sage` -> `sage`; anything outside the id alphabet becomes `-`. */
export function avatarIdForName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
