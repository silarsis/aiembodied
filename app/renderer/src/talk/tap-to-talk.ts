/** A tap starts talking unless it lands on a control (a button, a field, a link). */
export function isTalkTapTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return !target.closest(
    'button, a, input, select, textarea, label, summary, [role="button"], [contenteditable="true"], [data-no-tap-to-talk]',
  );
}
