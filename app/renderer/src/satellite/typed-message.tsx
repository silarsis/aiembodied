import { useState, type FormEvent } from 'react';

/**
 * A line to type to the characters (a satellite has no microphone yet). Enter sends. It runs the same turn that
 * speech does, so the answer is spoken, tagged and lip-synced the same way.
 */
export function TypedMessage({ onSend, disabled, placeholder }: { onSend: (text: string) => Promise<boolean>; disabled: boolean; placeholder?: string }) {
  const [text, setText] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim();
    if (!line || disabled) return;
    // Cleared at once; put back if the turn could not start (busy or not connected).
    setText('');
    const started = await onSend(line);
    if (!started) setText(line);
  };
  return (
    <form className="typedMessage" onSubmit={(event) => void submit(event)} data-testid="typed-message">
      <input
        className="typedMessage__input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder ?? 'Type to the characters…'}
        aria-label="Message"
        disabled={disabled}
        autoComplete="off"
      />
      <button type="submit" className="btn typedMessage__send" disabled={disabled || text.trim().length === 0}>
        Send
      </button>
    </form>
  );
}
