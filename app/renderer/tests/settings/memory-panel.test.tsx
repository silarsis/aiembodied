import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryEngineBridge, MemoryEngineStoredFact } from '../../../main/src/memory-engine/bridge-types.js';
import { MemoryPanel } from '../../src/settings/memory-panel.js';

const fact: MemoryEngineStoredFact = {
  id: '11111111-1111-4111-8111-111111111111',
  text: 'Prefers tea to coffee',
  subject: 'drinks',
  status: 'active',
  pinned: false,
  author: 'extractor',
  agent: 'Echo',
  session_id: '22222222-2222-4222-8222-222222222222',
  source_message_ids: [],
  supersedes: null,
  private: false,
  reviewed_at: null,
  created_at: new Date(2026, 10, 1).toISOString(),
};

function bridge(overrides: Partial<MemoryEngineBridge> = {}) {
  const memory: MemoryEngineBridge = {
    status: vi.fn().mockResolvedValue({
      enabled: true,
      url: 'http://127.0.0.1:8194',
      reachable: true,
      pending: 0,
      error: null,
      health: { database: 'ready', counts: { sessions: 3, messages: 40 }, embedder: 'bge', summariser: { model: 'qwen' } },
    }),
    search: vi.fn().mockResolvedValue([]),
    timeline: vi.fn().mockResolvedValue({
      summaries: [],
      sessions: [
        {
          session_id: '22222222-2222-4222-8222-222222222222',
          agent: 'Echo',
          channel: 'voice',
          title: null,
          started_at: new Date().toISOString(),
          last_at: new Date().toISOString(),
          message_count: 4,
          summary: { id: 'x', title: 'Morning drinks', text: 'They talked about tea.', topics: [] },
          turns: [],
        },
      ],
    }),
    memory: vi.fn(),
    facts: vi.fn().mockResolvedValue([fact]),
    addFact: vi.fn().mockResolvedValue({ id: 'new' }),
    updateFact: vi.fn().mockResolvedValue({ id: fact.id }),
    reviewFacts: vi.fn().mockResolvedValue({ reviewed: 1 }),
    deleteFact: vi.fn().mockResolvedValue({}),
    forgetSession: vi.fn().mockResolvedValue({ forgotten: 'x', dropped: 0 }),
    recallLog: vi.fn().mockResolvedValue([]),
    runSummaries: vi.fn().mockResolvedValue({ done: [] }),
    ...overrides,
  };
  return memory;
}

describe('Memory panel', () => {
  it('shows the engine status and the known facts, and corrects one', async () => {
    const memory = bridge();
    render(<MemoryPanel memory={memory} active />);
    expect(await screen.findByText('Prefers tea to coffee')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('3 conversations, 40 messages · meaning search on · summaries by qwen');
    expect(screen.getByText(/found in a conversation/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Not true' }));
    await waitFor(() => expect(memory.updateFact).toHaveBeenCalledWith(fact.id, { status: 'retracted', reviewed: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(memory.updateFact).toHaveBeenCalledWith(fact.id, { pinned: true, reviewed: true }));
  });

  it('adds a fact, and deletes only after a second press', async () => {
    const memory = bridge();
    render(<MemoryPanel memory={memory} active />);
    await screen.findByText('Prefers tea to coffee');
    const form = screen.getByRole('form', { name: 'Add a fact' });
    fireEvent.change(within(form).getByPlaceholderText('Prefers tea to coffee'), { target: { value: 'Has a dog called Rex' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(memory.addFact).toHaveBeenCalledWith({ text: 'Has a dog called Rex', subject: undefined, pinned: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(memory.deleteFact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Really delete?' }));
    await waitFor(() => expect(memory.deleteFact).toHaveBeenCalledWith(fact.id));
  });

  it('lists a day of conversations and forgets one after confirming', async () => {
    const memory = bridge();
    render(<MemoryPanel memory={memory} active />);
    fireEvent.click(screen.getByRole('tab', { name: 'Conversations' }));
    expect(await screen.findByText('Morning drinks')).toBeInTheDocument();
    expect(screen.getByText('They talked about tea.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget this conversation' }));
    fireEvent.click(screen.getByRole('button', { name: /Really forget it/ }));
    await waitFor(() => expect(memory.forgetSession).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222'));
  });

  it('says so when the engine is down, without loading anything', async () => {
    const memory = bridge({
      status: vi.fn().mockResolvedValue({ enabled: true, url: 'http://127.0.0.1:8194', reachable: false, pending: 5, error: 'refused', health: null }),
    });
    render(<MemoryPanel memory={memory} active />);
    expect(await screen.findByText(/isn’t reachable at http:\/\/127.0.0.1:8194\. 5 writes are queued/)).toBeInTheDocument();
    expect(memory.facts).not.toHaveBeenCalled();
  });
});
