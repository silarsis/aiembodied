import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AssistantStatusPanel,
  MAX_TOOL_CALLS,
  addToolCall,
  finishToolCall,
  type ToolCall,
} from '../../src/status/assistant-status.js';

const call = (id: string, overrides: Partial<ToolCall> = {}): ToolCall => ({
  id,
  kind: 'move',
  label: `move ${id}`,
  status: 'pending',
  startedAt: 1000,
  ...overrides,
});

describe('AssistantStatusPanel', () => {
  it('marks the current stage and the ones before it', () => {
    render(
      <AssistantStatusPanel activity={{ phase: 'thinking', detail: '“hello”', since: Date.now() }} wakeScore={null} toolCalls={[]} />,
    );

    const stages = screen.getByRole('list', { name: 'Conversation stage' });
    const items = within(stages).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-state'))).toEqual(['done', 'done', 'done', 'active', 'idle']);
    expect(within(stages).getByText('Thinking').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('assistant-status-summary')).toHaveTextContent('Thinking of a reply');
    expect(screen.getByTestId('assistant-status-detail')).toHaveTextContent('“hello”');
  });

  it('prompts for the wake phrase while waiting', () => {
    render(
      <AssistantStatusPanel activity={{ phase: 'waiting', since: Date.now() }} wakeScore={null} toolCalls={[]} wakePhrase="Hey Jarvis" />,
    );

    expect(screen.getByTestId('assistant-status-summary')).toHaveTextContent('Waiting for the wake word (say “Hey Jarvis”)');
    expect(screen.getByTestId('wake-score')).toHaveTextContent('Nothing close to the wake word yet');
  });

  it('shows errors as an alert', () => {
    render(
      <AssistantStatusPanel
        activity={{ phase: 'error', detail: 'Turn failed: connection refused', since: Date.now() }}
        wakeScore={null}
        toolCalls={[]}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Turn failed: connection refused');
  });

  it('shows how close the last wake-word score came to the threshold', () => {
    render(
      <AssistantStatusPanel
        activity={{ phase: 'waiting', since: Date.now() }}
        wakeScore={{ score: 0.31, threshold: 0.5, at: Date.now(), detected: false }}
        toolCalls={[]}
      />,
    );

    expect(screen.getByTestId('wake-score')).toHaveTextContent('0.31 / 0.50 below threshold');
  });

  it('lists tool calls with their status and detail', () => {
    render(
      <AssistantStatusPanel
        activity={{ phase: 'responding', since: Date.now() }}
        wakeScore={null}
        toolCalls={[
          call('a', { label: 'wave hello', status: 'done', finishedAt: 3500, detail: '2 chunks' }),
          call('b', { kind: 'pose', label: 'thinker', status: 'failed', finishedAt: 1200, detail: 'not found' }),
        ]}
      />,
    );

    const items = within(screen.getByTestId('tool-calls')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('wave hello');
    expect(items[0]).toHaveTextContent('done · 2.5 s');
    expect(items[0]).toHaveTextContent('2 chunks');
    expect(items[1]).toHaveAttribute('data-status', 'failed');
    expect(items[1]).toHaveTextContent('not found');
  });
});

describe('tool call list helpers', () => {
  it('keeps the newest calls first, up to the limit', () => {
    let calls: ToolCall[] = [];
    for (let i = 0; i < MAX_TOOL_CALLS + 3; i += 1) {
      calls = addToolCall(calls, call(String(i)));
    }
    expect(calls).toHaveLength(MAX_TOOL_CALLS);
    expect(calls[0]?.id).toBe(String(MAX_TOOL_CALLS + 2));
  });

  it('finishes only the matching call', () => {
    const calls = finishToolCall([call('a'), call('b')], 'b', 'failed', 2000, 'boom');
    expect(calls[0]).toMatchObject({ id: 'a', status: 'pending' });
    expect(calls[1]).toMatchObject({ id: 'b', status: 'failed', finishedAt: 2000, detail: 'boom' });
  });
});
