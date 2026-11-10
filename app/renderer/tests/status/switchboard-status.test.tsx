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
});
