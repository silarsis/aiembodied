import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DoNotDisturbToggle } from '../../src/status/dnd-toggle.js';

describe('DoNotDisturbToggle', () => {
  it('reads the saved state and saves a change', async () => {
    const api = { update: vi.fn(), getDoNotDisturb: vi.fn(async () => true), setDoNotDisturb: vi.fn(async (v: boolean) => v) };
    render(<DoNotDisturbToggle api={api} />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    expect(api.setDoNotDisturb).toHaveBeenCalledWith(false);
    await waitFor(() => expect(box.checked).toBe(false));
  });
  it('renders nothing without the bridge', () => {
    const { container } = render(<DoNotDisturbToggle />);
    expect(container.firstChild).toBeNull();
  });
});
