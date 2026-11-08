/**
 * Things the assistant wants to do that wait for Kevin's go-ahead (starting a coding task, opening
 * a pull request). Shown prominently in the status panel and as a small banner on the main screen.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalsBridge, ApprovalView } from '../../../main/src/tools/approvals-ipc.js';

export function ApprovalsCard({ api, floating = false }: { api?: ApprovalsBridge; floating?: boolean }) {
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.list())
      .then((list) => {
        if (!cancelled) setApprovals(list);
      })
      .catch(() => undefined);
    const off = api.onChanged((list) => setApprovals(list));
    return () => {
      cancelled = true;
      off();
    };
  }, [api]);

  const settle = useCallback(
    async (id: string, action: 'approve' | 'decline') => {
      if (!api) return;
      setBusy(id);
      setError(null);
      try {
        const outcome = await (action === 'approve' ? api.approve(id) : api.decline(id));
        if (outcome === null) setError('That request is no longer pending.');
        else if (action === 'approve' && outcome.ok === false) setError(`It was approved but failed: ${outcome.result ?? 'unknown error'}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  if (!api || (approvals.length === 0 && !error)) return null;
  return (
    <section
      className={`approvals${floating ? ' approvals--floating' : ''}`}
      aria-label="Waiting for your approval"
      data-testid={floating ? 'approvals-floating' : 'approvals'}
    >
      {approvals.length > 0 ? <h3 className="approvals__title">Waiting for your approval</h3> : null}
      {approvals.map((approval) => (
        <div className="approvals__item" key={approval.id} data-testid="approval">
          <p className="approvals__summary">{approval.summary}</p>
          {approval.cardOnly ? <p className="approvals__note">This one can only be approved here, not by voice.</p> : <p className="approvals__note">You can also say yes or no.</p>}
          <div className="approvals__actions">
            <button type="button" className="approvals__approve" disabled={busy === approval.id} onClick={() => void settle(approval.id, 'approve')}>
              Approve
            </button>
            <button type="button" disabled={busy === approval.id} onClick={() => void settle(approval.id, 'decline')}>
              Decline
            </button>
          </div>
        </div>
      ))}
      {error ? <p className="approvals__error" role="alert">{error}</p> : null}
    </section>
  );
}
