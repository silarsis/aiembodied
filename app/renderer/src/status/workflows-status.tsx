/** The workflows service in Status and diagnostics: is it up, can it reach Temporal, who has a life workflow and who is asleep. */
import { useEffect, useState } from 'react';
import type {
  WorkflowsBridge,
  WorkflowsStatus,
} from '../../../main/src/shared/agent-time/bridge-types.js';

export const WORKFLOWS_POLL_MS = 5000;

export function describeWorkflows(status: WorkflowsStatus | null): {
  dot: 'connected' | 'down' | 'off' | 'checking';
  label: string;
} {
  if (!status) return { dot: 'checking', label: 'Checking…' };
  if (!status.enabled) return { dot: 'off', label: 'Off' };
  if (!status.reachable) return { dot: 'down', label: 'Not running' };
  if (status.temporal === false)
    return { dot: 'down', label: 'Running, but Temporal is not reachable' };
  return { dot: 'connected', label: 'Connected' };
}

const DOT_COLOUR = { connected: '#34d399', down: '#f87171', off: '#64748b', checking: '#fbbf24' };

export function WorkflowsView({ status }: { status: WorkflowsStatus | null }) {
  const { dot, label } = describeWorkflows(status);
  return (
    <div data-testid="workflows-status">
      <p className="kiosk__helper">
        <span
          data-testid="workflows-dot"
          data-state={dot}
          aria-hidden
          style={{
            display: 'inline-block',
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: DOT_COLOUR[dot],
            marginRight: 6,
          }}
        />
        <b>Agent workflows</b>: {label}
        {status?.enabled && status.reachable
          ? ` (Temporal ${status.temporal ? 'up' : 'down'})`
          : ''}
      </p>
      {status?.enabled && status.reachable ? (
        <p className="kiosk__helper" data-testid="workflows-agents">
          {status.agentLife ? 'Life workflows' : 'Life workflows off'}:{' '}
          {status.agents.length > 0 ? status.agents.join(', ') : 'none yet'}
          {status.asleep.length > 0 ? `. Asleep: ${status.asleep.join(', ')}` : ''}
        </p>
      ) : null}
      {status?.enabled && status.temporalUiUrl ? (
        <p className="kiosk__helper" data-testid="workflows-ui">
          Temporal UI:{' '}
          <a href={status.temporalUiUrl} target="_blank" rel="noreferrer">
            {status.temporalUiUrl}
          </a>
        </p>
      ) : null}
    </div>
  );
}

export function WorkflowsStatusLine({ api, active }: { api?: WorkflowsBridge; active: boolean }) {
  const [status, setStatus] = useState<WorkflowsStatus | null>(null);
  useEffect(() => {
    if (!api || !active) return undefined;
    let cancelled = false;
    const read = () => {
      void Promise.resolve()
        .then(() => api.status())
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, WORKFLOWS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, active]);
  if (!api) return null;
  return <WorkflowsView status={status} />;
}
