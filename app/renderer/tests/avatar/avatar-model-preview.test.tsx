import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarModelPreview } from '../../src/avatar/avatar-model-preview.js';
import { createModelReviewScene } from '../../src/avatar/model-review-scene.js';

vi.mock('../../src/avatar/model-review-scene.js', () => ({ createModelReviewScene: vi.fn() }));
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.open = false;
    },
  });
});
afterAll(() => {
  for (const [name, descriptor] of [
    ['showModal', originalShow],
    ['close', originalClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
const scene = {
  view: vi.fn(),
  expression: vi.fn(),
  expressions: ['happy', 'fear', 'aa'],
  dispose: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createModelReviewScene).mockResolvedValue(scene);
});
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Inspect finished avatar model' }));
  await screen.findByRole('button', { name: 'Back' });
  await act(async () => {
    await Promise.resolve();
  });
}
describe('interactive avatar candidate review', () => {
  it('loads only when opened, inspects the exact candidate, and disposes on close', async () => {
    const data = new ArrayBuffer(8);
    const { container } = render(<AvatarModelPreview thumbnail="preview.png" modelData={data} />);
    expect(createModelReviewScene).not.toHaveBeenCalled();
    await open();
    expect(createModelReviewScene).toHaveBeenCalledWith(expect.any(HTMLElement), data);
    expect(container).not.toContainElement(screen.getByRole('dialog'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(scene.view).toHaveBeenCalledWith('back');
    fireEvent.change(screen.getByLabelText('Expression'), { target: { value: 'fear' } });
    expect(scene.expression).toHaveBeenCalledWith('fear');
    fireEvent.change(screen.getByLabelText('Expression'), { target: { value: '' } });
    expect(scene.expression).toHaveBeenCalledWith('');
    const key = vi.fn();
    window.addEventListener('keydown', key);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(key).not.toHaveBeenCalled();
    window.removeEventListener('keydown', key);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(scene.dispose).toHaveBeenCalledOnce();
  });
  it('disposes a model that finishes loading after its popup was closed', async () => {
    let finish!: (value: typeof scene) => void;
    vi.mocked(createModelReviewScene).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<AvatarModelPreview thumbnail="preview.png" modelData={new ArrayBuffer(8)} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close model preview' }));
    await act(async () => {
      finish(scene);
    });
    expect(scene.dispose).toHaveBeenCalledOnce();
  });
  it('shows a loading failure and permits closing and reopening to retry', async () => {
    vi.mocked(createModelReviewScene).mockRejectedValueOnce(new Error('Graphics unavailable'));
    render(<AvatarModelPreview thumbnail="preview.png" modelData={new ArrayBuffer(8)} />);
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Graphics unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Close model preview' }));
    await open();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(createModelReviewScene).toHaveBeenCalledTimes(2);
  });
});
