import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { opensTypedPrompt, TypedPrompt } from '../../src/talk/type-to-talk.js';

function enterOn(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('opensTypedPrompt', () => {
  it('opens on a plain Enter outside controls', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(opensTypedPrompt(enterOn(div))).toBe(true);
    expect(opensTypedPrompt(enterOn(document.body))).toBe(true);
  });

  it('leaves fields, buttons, dialogs, modifiers and other keys alone', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inner = document.createElement('span');
    dialog.appendChild(inner);
    document.body.append(input, button, dialog);
    expect(opensTypedPrompt(enterOn(input))).toBe(false);
    expect(opensTypedPrompt(enterOn(button))).toBe(false);
    expect(opensTypedPrompt(enterOn(inner))).toBe(false);
    expect(opensTypedPrompt(enterOn(document.body, { shiftKey: true }))).toBe(false);
    expect(opensTypedPrompt(enterOn(document.body, { ctrlKey: true }))).toBe(false);
    expect(opensTypedPrompt(enterOn(document.body, { repeat: true }))).toBe(false);
    expect(opensTypedPrompt(enterOn(document.body, { key: 'a' }))).toBe(false);
  });
});

describe('TypedPrompt', () => {
  it('focuses, sends on Enter and closes', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<TypedPrompt onSend={onSend} onClose={onClose} />);
    const input = screen.getByLabelText('Typed message');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '  what time is it?  ' } });
    fireEvent.submit(screen.getByTestId('typed-prompt'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith('what time is it?');
  });

  it('keeps the text with a note when the turn could not start', async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    render(<TypedPrompt onSend={onSend} onClose={onClose} />);
    const input = screen.getByLabelText('Typed message');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(screen.getByTestId('typed-prompt'));
    await screen.findByRole('status');
    expect(onClose).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('hello');
  });

  it('closes on Escape and on Enter with nothing typed', () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(<TypedPrompt onSend={onSend} onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText('Typed message'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    render(<TypedPrompt onSend={onSend} onClose={onClose} />);
    fireEvent.submit(screen.getByTestId('typed-prompt'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
  });
});
