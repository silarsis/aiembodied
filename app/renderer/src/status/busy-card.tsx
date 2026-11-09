/**
 * Shown on the main screen while Echo is getting its own model back from the coding agent, so
 * Kevin knows why the answer takes a moment.
 */
import { useEffect, useState } from 'react';
import type { CodingBusyBridge } from '../../../main/src/coding/bridge-types.js';

export function BusyCard({ api }: { api?: CodingBusyBridge }) {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return undefined;
    return api.onChanged((state) => setMessage(state.busy ? (state.message ?? 'Hang on, I’m busy, be with you in a sec…') : null));
  }, [api]);

  if (!message) return null;
  return (
    <section className="approvals busy-card--floating" role="status" aria-live="polite" data-testid="busy-card">
      <p className="approvals__summary">{message}</p>
      <p className="approvals__note">Swapping the coding model out for my voice model.</p>
    </section>
  );
}
