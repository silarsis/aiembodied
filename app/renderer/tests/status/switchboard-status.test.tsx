import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SwitchboardView } from '../../src/status/switchboard-status.js';

describe('SwitchboardView', () => {
  it('shows the dot and open transactions', () => {
    const now = Date.parse('2026-01-01T00:02:00Z');
    render(<SwitchboardView now={now} status={{ enabled: true, connected: true, url: 'u', openTxns: [{ id: 'task:1', title: 'Add hello', state: 'progress', opened_by: null, owner: null, updated_at: '2026-01-01T00:00:00Z' }, { id: 'task:2', title: null, state: 'open', opened_by: null, owner: null, updated_at: null }] }} />);
    expect(screen.getByTestId('switchboard-dot').getAttribute('data-state')).toBe('connected');
    expect(screen.getByTestId('switchboard-txns').textContent).toContain('Add hello (progress, 2m)');
    expect(screen.getByTestId('switchboard-txns').textContent).toContain('task:2 (open)');
  });
  it('shows off and down', () => {
    const { rerender } = render(<SwitchboardView now={0} status={{ enabled: false, connected: false, url: null, openTxns: null }} />);
    expect(screen.getByTestId('switchboard-dot').getAttribute('data-state')).toBe('off');
    rerender(<SwitchboardView now={0} status={{ enabled: true, connected: false, url: 'u', openTxns: null }} />);
    expect(screen.getByTestId('switchboard-dot').getAttribute('data-state')).toBe('down');
  });
  it('lists recent decisions under a label, with a clipped reason and age', () => {
    const now = Date.parse('2026-01-01T00:05:00Z');
    const long = 'x'.repeat(200);
    const decision = (over: object) => ({ at: '2026-01-01T00:03:00Z', avatarId: 'echo', avatarName: 'Echo', event: 'e1', type: 'avatar.inbox', action: 'say', reason: 'Kevin is here', ms: 12, fallback: false, doNotDisturb: false, ...over });
    render(<SwitchboardView now={now} status={{ enabled: true, connected: false, url: 'u', openTxns: null, decisions: [decision({}), decision({ avatarId: 'sage', avatarName: 'Sage', event: 'e2', type: 'home.change', action: 'remember', reason: long })] }} />);
    expect(screen.getByText('Recent decisions')).toBeTruthy();
    const items = screen.getByTestId('switchboard-decisions').querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('Echo: say avatar.inbox (Kevin is here), 2m ago');
    expect(items[1].textContent).toContain('Sage: remember home.change (');
    expect(items[1].textContent).toContain('…');
    expect(items[1].textContent).not.toContain(long);
  });
  it('shows nothing for an empty or missing list', () => {
    const { rerender } = render(<SwitchboardView now={0} status={{ enabled: true, connected: true, url: 'u', openTxns: [], decisions: [] }} />);
    expect(screen.queryByText('Recent decisions')).toBeNull();
    expect(screen.queryByTestId('switchboard-decisions')).toBeNull();
    rerender(<SwitchboardView now={0} status={{ enabled: true, connected: true, url: 'u', openTxns: [] }} />);
    expect(screen.queryByText('Recent decisions')).toBeNull();
  });
});
