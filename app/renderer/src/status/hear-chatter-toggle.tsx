/** "Hear avatar chatter" in Status and diagnostics: whether avatars talk to each other out loud. */
import { useEffect, useState } from 'react';
import type { FloorBridge } from '../../../main/src/floor/bridge-types.js';

export function HearChatterToggle({ api }: { api?: FloorBridge }) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.getHearChatter())
      .then((value) => {
        if (cancelled) return;
        setEnabled(value === true);
        setReady(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);
  if (!api) return null;
  const toggle = (next: boolean) => {
    setEnabled(next);
    void Promise.resolve(api.setHearChatter(next))
      .then((value) => setEnabled(value === true))
      .catch(() => setEnabled(!next));
  };
  return (
    <label className="kiosk__helper" data-testid="hear-chatter-toggle">
      <input type="checkbox" checked={enabled} disabled={!ready} onChange={(event) => toggle(event.target.checked)} /> Hear avatar chatter
      <span> (avatars talk to each other out loud; otherwise it stays in text)</span>
    </label>
  );
}
