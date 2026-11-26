import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

/**
 * Enter (outside a field, a button or a link, with no modifier) opens the typed prompt. Typing there runs the
 * same turn that speech does.
 */
export function opensTypedPrompt(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.repeat || event.defaultPrevented || event.isComposing) {
    return false;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return false;
  }
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      'button, a, input, select, textarea, summary, dialog, [role="button"], [role="dialog"], [contenteditable="true"], [data-no-typed-prompt]',
    )
  ) {
    return false;
  }
  return true;
}

/**
 * A one-line prompt at the bottom of the screen. Enter sends and closes it; Escape (or leaving it empty) closes it.
 * If the turn could not start, the text stays with a note so nothing typed is lost.
 */
export function TypedPrompt({
  onSend,
  onClose,
}: {
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim();
    if (sending) return;
    if (!line) {
      onClose();
      return;
    }
    setSending(true);
    setNote(null);
    let started = false;
    try {
      started = await onSend(line);
    } catch {
      started = false;
    }
    setSending(false);
    if (started) {
      onClose();
      return;
    }
    setNote('Could not send yet (still answering or not connected). Press Enter to try again.');
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <form
      className="typedPrompt"
      onSubmit={(event) => void submit(event)}
      data-testid="typed-prompt"
      data-no-tap-to-talk
    >
      <input
        ref={inputRef}
        className="typedPrompt__input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!text.trim() && !sending) onClose();
        }}
        placeholder="Type instead of speaking. Enter sends, Escape cancels."
        aria-label="Typed message"
        readOnly={sending}
        autoComplete="off"
        spellCheck
      />
      {note ? (
        <p className="typedPrompt__note" role="status">
          {note}
        </p>
      ) : null}
    </form>
  );
}
