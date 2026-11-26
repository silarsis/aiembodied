import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PursuitOffer, PursuitsBridge } from '../../../main/src/shared/pursuits/types.js';
import { offersFor, usePursuits } from '../../src/rooms/use-pursuits.js';

const READING = 'room:builtin:reading-room';
const shelf: PursuitOffer = {
  stationId: 's1',
  roomId: READING,
  objectId: 'bookshelf',
  objectName: 'bookshelf',
  characters: 'all',
};
const sageOnly: PursuitOffer = {
  stationId: 's2',
  roomId: READING,
  objectId: 'desk',
  objectName: 'desk',
  characters: ['sage'],
};
const elsewhere: PursuitOffer = {
  stationId: 's3',
  roomId: 'room:builtin:studio-flat',
  objectId: 'shelf',
  objectName: 'shelf',
  characters: 'all',
};

function bridge(overrides: Partial<PursuitsBridge> = {}) {
  let listener: ((running: string[]) => void) | null = null;
  const api: PursuitsBridge = {
    start: vi.fn(async () => ({ ok: true })),
    offers: vi.fn(async () => [shelf, sageOnly, elsewhere]),
    running: vi.fn(async () => []),
    onChanged: vi.fn((fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    }),
    notes: vi.fn(async () => []),
    ...overrides,
  };
  return { api, push: (ids: string[]) => listener?.(ids) };
}

describe('offersFor', () => {
  it('keeps the stations of this room that this character may use', () => {
    expect(
      offersFor([shelf, sageOnly, elsewhere], READING, 'echo').map((o) => o.stationId),
    ).toEqual(['s1']);
    expect(
      offersFor([shelf, sageOnly, elsewhere], READING, 'sage').map((o) => o.stationId),
    ).toEqual(['s1', 's2']);
    expect(offersFor([shelf], null, 'echo')).toEqual([]);
  });
});

describe('usePursuits', () => {
  it('offers the stations of the room once they are read, and follows who is reading', async () => {
    const { api, push } = bridge();
    const { result } = renderHook(() => usePursuits(api, READING));
    await waitFor(() => expect(result.current.pursuitsFor('echo')).toHaveLength(1));
    expect(result.current.pursuing('sage')).toBe(false);
    act(() => push(['sage']));
    expect(result.current.pursuing('sage')).toBe(true);
    act(() => push([]));
    expect(result.current.pursuing('sage')).toBe(false);
  });

  it('counts an avatar as reading as soon as it starts, and not when main refuses', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'no' })
      .mockResolvedValueOnce({ ok: true });
    const { api } = bridge({ start });
    const { result } = renderHook(() => usePursuits(api, READING));
    await expect(result.current.startPursuit('echo', 's1')).resolves.toBe(false);
    expect(result.current.pursuing('echo')).toBe(false);
    const pending = result.current.startPursuit('echo', 's1');
    expect(result.current.pursuing('echo')).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it('does nothing without a bridge', async () => {
    const { result } = renderHook(() => usePursuits(undefined, READING));
    expect(result.current.pursuitsFor('echo')).toEqual([]);
    await expect(result.current.startPursuit('echo', 's1')).resolves.toBe(false);
  });
});
