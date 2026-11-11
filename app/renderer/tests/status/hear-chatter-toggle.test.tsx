import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HearChatterToggle } from '../../src/status/hear-chatter-toggle.js';

describe('HearChatterToggle', () => {
  it('reads the saved state and saves a change', async () => {
    const api = { getHearChatter: vi.fn(async () => true), setHearChatter: vi.fn(async (v: boolean) => v), interrupt: vi.fn(async () => undefined) };
    render(<HearChatterToggle api={api} />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    expect(api.setHearChatter).toHaveBeenCalledWith(false);
    await waitFor(() => expect(box.checked).toBe(false));
  });
  it('goes back when saving fails', async () => {
    const api = { getHearChatter: vi.fn(async () => false), setHearChatter: vi.fn(async () => Promise.reject(new Error('no'))), interrupt: vi.fn(async () => undefined) };
    render(<HearChatterToggle api={api} />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
  });
  it('renders nothing without the bridge', () => {
    const { container } = render(<HearChatterToggle />);
    expect(container.firstChild).toBeNull();
  });
});
