import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AvatarImagePreview } from '../../src/avatar/avatar-image-preview.js';

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
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

describe('avatar image preview', () => {
  it('opens the original image in a popup outside the drawer and closes it', () => {
    const { container } = render(
      <AvatarImagePreview
        src="data:image/png;base64,ORIGINAL"
        alt="Generated concept"
        caption="Concept image"
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge generated concept' }));
    const dialog = screen.getByRole('dialog', { name: 'Generated concept full-size preview' });
    expect(container).not.toContainElement(dialog);
    expect(within(dialog).getByRole('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,ORIGINAL',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('handles Escape in the image popup without sending it to the drawer', () => {
    const onKey = vi.fn();
    window.addEventListener('keydown', onKey);
    render(
      <AvatarImagePreview src="image.png" alt="Finished avatar model" caption="Finished model" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge finished avatar model' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onKey).not.toHaveBeenCalled();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    window.removeEventListener('keydown', onKey);
  });
});
