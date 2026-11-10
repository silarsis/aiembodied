/** "Do not disturb" in Status and diagnostics: Echo saves updates quietly instead of speaking them. */
import { useEffect, useState } from 'react';
import type { PresenceBridge } from '../../../main/src/presence/bridge-types.js';

export function DoNotDisturbToggle({ api }: { api?: PresenceBridge }) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.getDoNotDisturb())
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
    void Promise.resolve(api.setDoNotDisturb(next))
      .then((value) => setEnabled(value === true))
      .catch(() => setEnabled(!next));
  };
  return (
    <label className="kiosk__helper" data-testid="dnd-toggle">
      <input type="checkbox" checked={enabled} disabled={!ready} onChange={(event) => toggle(event.target.checked)} /> Do not disturb
      <span> (Echo keeps non-urgent updates quiet)</span>
    </label>
  );
}
