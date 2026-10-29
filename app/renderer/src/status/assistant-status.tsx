/**
 * Live status of the assistant: which stage of a turn it is in, how close the last speech came
 * to the wake word, and the tool calls (motion generation, animations, poses) it has made.
 */
import { useEffect, useState } from 'react';
import type { VoiceActivity, VoicePhase } from '../realtime/voice-activity.js';

export type ToolCallStatus = 'pending' | 'done' | 'failed';

export interface ToolCall {
  id: string;
  /** e.g. "move", "animation", "pose" */
  kind: string;
  label: string;
  status: ToolCallStatus;
  startedAt: number;
  finishedAt?: number;
  detail?: string;
}

export interface WakeScore {
  score: number;
  threshold: number;
  at: number;
  detected: boolean;
}

export const MAX_TOOL_CALLS = 8;

const PHASES: { phase: VoicePhase; label: string }[] = [
  { phase: 'waiting', label: 'Waiting' },
  { phase: 'listening', label: 'Listening' },
  { phase: 'transcribing', label: 'Transcribing' },
  { phase: 'thinking', label: 'Thinking' },
  { phase: 'responding', label: 'Responding' },
];

const PHASE_DESCRIPTIONS: Record<VoicePhase, string> = {
  off: 'Listening is off',
  waiting: 'Waiting for the wake word',
  listening: 'Listening for your request',
  transcribing: 'Transcribing what you said',
  thinking: 'Thinking of a reply',
  responding: 'Speaking',
  error: 'Something went wrong',
};

/** Adds a call to the front of the list, keeping the most recent `MAX_TOOL_CALLS`. */
export function addToolCall(calls: ToolCall[], call: ToolCall): ToolCall[] {
  return [call, ...calls].slice(0, MAX_TOOL_CALLS);
}

export function finishToolCall(
  calls: ToolCall[],
  id: string,
  status: Exclude<ToolCallStatus, 'pending'>,
  finishedAt: number,
  detail?: string,
): ToolCall[] {
  return calls.map((call) => (call.id === id ? { ...call, status, finishedAt, detail: detail ?? call.detail } : call));
}

function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

export interface AssistantStatusPanelProps {
  activity: VoiceActivity;
  wakeScore: WakeScore | null;
  toolCalls: ToolCall[];
  wakePhrase?: string;
}

export function AssistantStatusPanel({ activity, wakeScore, toolCalls, wakePhrase }: AssistantStatusPanelProps) {
  const ticking = activity.phase !== 'off' || toolCalls.some((call) => call.status === 'pending');
  const now = useNow(ticking);
  const activeIndex = PHASES.findIndex((entry) => entry.phase === activity.phase);

  return (
    <div className="assistantStatus" data-testid="assistant-status" data-phase={activity.phase}>
      <ol className="assistantStatus__phases" aria-label="Conversation stage">
        {PHASES.map((entry, index) => {
          const state = index === activeIndex ? 'active' : activeIndex > index ? 'done' : 'idle';
          return (
            <li
              key={entry.phase}
              className="assistantStatus__phase"
              data-state={state}
              aria-current={state === 'active' ? 'step' : undefined}
            >
              <span className="assistantStatus__dot" aria-hidden="true" />
              {entry.label}
            </li>
          );
        })}
      </ol>

      <p className="assistantStatus__summary" role="status" aria-live="polite" data-testid="assistant-status-summary">
        <strong>{PHASE_DESCRIPTIONS[activity.phase]}</strong>
        {activity.phase === 'waiting' && wakePhrase ? ` (say “${wakePhrase}”)` : null}
        {activity.phase !== 'off' ? <span className="assistantStatus__elapsed"> · {formatSeconds(now - activity.since)}</span> : null}
      </p>
      {activity.detail ? (
        <p
          className={activity.phase === 'error' ? 'assistantStatus__detail assistantStatus__detail--error' : 'assistantStatus__detail'}
          role={activity.phase === 'error' ? 'alert' : undefined}
          data-testid="assistant-status-detail"
        >
          {activity.detail}
        </p>
      ) : null}

      <div className="assistantStatus__wake" data-testid="wake-score">
        <span className="assistantStatus__label">Last wake-word score</span>
        {wakeScore ? (
          <>
            <div className="meter assistantStatus__wakeMeter" aria-hidden="true">
              <div
                className="meter__fill"
                data-detected={wakeScore.detected ? 'true' : 'false'}
                style={{ width: `${Math.round(Math.min(1, wakeScore.score) * 100)}%` }}
              />
              <div className="assistantStatus__threshold" style={{ left: `${Math.round(wakeScore.threshold * 100)}%` }} />
            </div>
            <span className="assistantStatus__wakeValue">
              {wakeScore.score.toFixed(2)} / {wakeScore.threshold.toFixed(2)} {wakeScore.detected ? 'heard' : 'below threshold'} ·{' '}
              {formatSeconds(now - wakeScore.at)} ago
            </span>
          </>
        ) : (
          <span className="assistantStatus__wakeValue">Nothing close to the wake word yet</span>
        )}
      </div>

      <div className="assistantStatus__tools">
        <span className="assistantStatus__label">Tool calls</span>
        {toolCalls.length === 0 ? (
          <p className="assistantStatus__empty">None yet</p>
        ) : (
          <ul className="assistantStatus__toolList" data-testid="tool-calls">
            {toolCalls.map((call) => (
              <li key={call.id} className="assistantStatus__tool" data-status={call.status}>
                <span className="assistantStatus__toolKind">{call.kind}</span>
                <span className="assistantStatus__toolLabel">{call.label}</span>
                <span className="assistantStatus__toolStatus">
                  {call.status === 'pending' ? 'running' : call.status} ·{' '}
                  {formatSeconds((call.finishedAt ?? now) - call.startedAt)}
                </span>
                {call.detail ? <span className="assistantStatus__toolDetail">{call.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
