import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useIdleHabits } from '../../src/avatar/use-idle-habits.js';

describe('useIdleHabits', () => {
  it('loads the character’s habits, reloads for another character and saves trimmed text of at most 500 characters', async () => {
    const api = { getIdleHabits: vi.fn().mockResolvedValue('Sits by the window.'), setIdleHabits: vi.fn().mockResolvedValue(undefined) };
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useIdleHabits(api, id), { initialProps: { id: 'mei' } });
    await waitFor(() => expect(result.current.habits).toBe('Sits by the window.'));
    expect(result.current.available).toBe(true);

    api.getIdleHabits.mockResolvedValue('');
    rerender({ id: 'ren' });
    await waitFor(() => expect(result.current.habits).toBe(''));

    act(() => result.current.setHabits(`  ${'x'.repeat(600)}  `));
    await act(async () => result.current.save());
    expect(api.setIdleHabits).toHaveBeenCalledWith('x'.repeat(500));
  });

  it('does nothing without a character or a bridge', async () => {
    const api = { getIdleHabits: vi.fn(), setIdleHabits: vi.fn() };
    const { result } = renderHook(() => useIdleHabits(api, undefined));
    await act(async () => result.current.save());
    expect(api.getIdleHabits).not.toHaveBeenCalled();
    expect(api.setIdleHabits).not.toHaveBeenCalled();
    expect(result.current.available).toBe(false);
    const bare = renderHook(() => useIdleHabits(undefined, 'mei'));
    expect(bare.result.current.available).toBe(false);
  });

  it('survives a failing bridge', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = { getIdleHabits: vi.fn().mockRejectedValue(new Error('no')), setIdleHabits: vi.fn().mockRejectedValue(new Error('no')) };
    const { result } = renderHook(() => useIdleHabits(api, 'mei'));
    await waitFor(() => expect(api.getIdleHabits).toHaveBeenCalled());
    await act(async () => result.current.save());
    expect(result.current.habits).toBe('');
  });
});
