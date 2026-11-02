import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarModelViewer } from '../../src/avatar/avatar-model-preview.js';
import { createModelReviewScene } from '../../src/avatar/model-review-scene.js';

vi.mock('../../src/avatar/model-review-scene.js', () => ({ createModelReviewScene: vi.fn() }));
const scene = {
  view: vi.fn(),
  expression: vi.fn(),
  pose: vi.fn(),
  expressions: ['happy', 'fear', 'aa'],
  dispose: vi.fn(),
};
const poses = [
  { id: 'builtin:happiness', name: 'Happiness', builtIn: true, createdAt: 0, fileSha: 'a' },
  { id: 'builtin:sadness', name: 'Sadness', builtIn: true, createdAt: 0, fileSha: 'b' },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createModelReviewScene).mockResolvedValue(scene);
});
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('interactive avatar candidate viewer', () => {
  it('inspects the exact candidate with views, poses and expressions, and disposes on unmount', async () => {
    const data = new ArrayBuffer(8);
    const loadPose = vi.fn().mockResolvedValue({ bones: { hips: { rotation: [0, 0, 0, 1] } } });
    const { unmount } = render(
      <AvatarModelViewer modelData={data} poses={poses} loadPose={loadPose} />,
    );
    await settle();
    expect(createModelReviewScene).toHaveBeenCalledWith(expect.any(HTMLElement), data);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(scene.view).toHaveBeenCalledWith('back');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Happiness' }));
    });
    expect(loadPose).toHaveBeenCalledWith('builtin:happiness');
    expect(scene.pose).toHaveBeenCalledWith({ bones: { hips: { rotation: [0, 0, 0, 1] } } });
    expect(screen.getByRole('button', { name: 'Happiness' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.change(screen.getByLabelText('Expression'), { target: { value: 'fear' } });
    expect(scene.expression).toHaveBeenCalledWith('fear');
    fireEvent.change(screen.getByLabelText('Expression'), { target: { value: '' } });
    expect(scene.pose).toHaveBeenCalledTimes(2);
    unmount();
    expect(scene.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a model that finishes loading after the viewer was removed', async () => {
    let finish!: (value: typeof scene) => void;
    vi.mocked(createModelReviewScene).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount } = render(<AvatarModelViewer modelData={new ArrayBuffer(8)} />);
    unmount();
    await act(async () => {
      finish(scene);
    });
    expect(scene.dispose).toHaveBeenCalledOnce();
  });

  it('shows a loading failure', async () => {
    vi.mocked(createModelReviewScene).mockRejectedValueOnce(new Error('Graphics unavailable'));
    render(<AvatarModelViewer modelData={new ArrayBuffer(8)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Graphics unavailable');
  });

  it('reports a pose that cannot be loaded', async () => {
    const loadPose = vi.fn().mockRejectedValue(new Error('Missing pose file'));
    render(<AvatarModelViewer modelData={new ArrayBuffer(8)} poses={poses} loadPose={loadPose} />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sadness' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Missing pose file');
    expect(scene.pose).not.toHaveBeenCalled();
  });
});
