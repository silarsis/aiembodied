import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PosePicker } from '../../src/avatar/pose-picker.js';
import {
  createAvatarAnimationBus,
  type AvatarAnimationEvent,
} from '../../src/avatar/animation-bus.js';
import type { AvatarBridge } from '../../src/avatar/types.js';

const poses = ['Relaxed', 'Thinking'].map((name) => ({
  id: name,
  name,
  createdAt: 0,
  fileSha: name,
}));
const pose = (angle: number) => ({ bones: { head: { rotation: [angle, 0, 0, 1] } } });

function setup() {
  const bus = createAvatarAnimationBus();
  const events: AvatarAnimationEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const loadPose = vi
    .fn()
    .mockImplementation(async (id: string) => pose(id === 'Relaxed' ? 0.1 : 0.2));
  const avatarApi = { loadPose } as unknown as AvatarBridge;
  return { bus, events, loadPose, avatarApi };
}

describe('saved pose chips', () => {
  it('previews on hover and keyboard focus, and restores the applied selection', async () => {
    const { bus, events, avatarApi } = setup();
    render(<PosePicker poses={poses} bus={bus} avatarApi={avatarApi} enabled modelId="model" />);
    const relaxed = screen.getByRole('button', { name: 'Relaxed' });
    fireEvent.mouseEnter(relaxed);
    await waitFor(() =>
      expect(events.at(-1)).toMatchObject({ type: 'applyPose', pose: pose(0.1) }),
    );
    fireEvent.mouseLeave(relaxed);
    expect(events.at(-1)).toEqual({ type: 'response' });
    fireEvent.click(relaxed);
    await waitFor(() =>
      expect(events.at(-1)).toMatchObject({ type: 'applyPose', pose: pose(0.1) }),
    );
    expect(relaxed).toHaveAttribute('aria-pressed', 'true');
    const thinking = screen.getByRole('button', { name: 'Thinking' });
    fireEvent.focus(thinking);
    await waitFor(() =>
      expect(events.at(-1)).toMatchObject({ type: 'applyPose', pose: pose(0.2) }),
    );
    fireEvent.blur(thinking);
    await waitFor(() =>
      expect(events.at(-1)).toMatchObject({ type: 'applyPose', pose: pose(0.1) }),
    );
  });

  it('ignores late loads when the pointer leaves or the drawer closes', async () => {
    const { bus, events, avatarApi, loadPose } = setup();
    let resolvePose!: (value: unknown) => void;
    loadPose.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePose = resolve;
        }),
    );
    const { rerender } = render(
      <PosePicker poses={poses} bus={bus} avatarApi={avatarApi} enabled modelId="model" />,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Thinking' }));
    rerender(
      <PosePicker poses={poses} bus={bus} avatarApi={avatarApi} enabled={false} modelId="model" />,
    );
    await act(async () => resolvePose(pose(0.2)));
    expect(events).toEqual([{ type: 'response' }]);
  });

  it('reports pose load errors without applying malformed data', async () => {
    const { bus, events, avatarApi, loadPose } = setup();
    loadPose.mockRejectedValue(new Error('Pose unavailable'));
    render(<PosePicker poses={poses} bus={bus} avatarApi={avatarApi} enabled modelId="model" />);
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pose unavailable');
    expect(events).toEqual([]);
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-pressed', 'false');
  });
});
