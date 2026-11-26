/** A character's reading notes in the Characters pop-up: what it wrote down while reading on its own. Read-only. */
import { useEffect, useState } from 'react';
import type { ReadingNote } from '../../../main/src/shared/pursuits/types.js';

/** How many notes the list asks for. */
export const READING_NOTES_SHOWN = 10;

export type LoadReadingNotes = (avatarId: string, limit: number) => Promise<ReadingNote[]>;

function day(at: number): string {
  return new Date(at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

/** Only web addresses become links. */
function safeHref(link: string | null): string | null {
  return link && /^https?:\/\//i.test(link) ? link : null;
}

function Note({ note }: { note: ReadingNote }) {
  const href = safeHref(note.link);
  return (
    <li className="readingNote" data-testid="reading-note">
      <details>
        <summary>
          <span className="readingNote__date">{day(note.createdAt)}</span>{' '}
          <span className="readingNote__title">{note.title}</span>
          {note.partial ? <span className="readingNote__badge"> (cut short)</span> : null}
          <span className="readingNote__takeaway"> {note.takeaway}</span>
        </summary>
        <div className="readingNote__full">
          {href ? (
            <p>
              <a href={href} target="_blank" rel="noreferrer noopener">
                {note.title}
              </a>{' '}
              <span className="kiosk__helper">{href}</span>
            </p>
          ) : null}
          <p>
            <strong>Takeaway.</strong> {note.takeaway}
          </p>
          {note.opinion ? (
            <p>
              <strong>Opinion.</strong> {note.opinion}
            </p>
          ) : null}
          {note.connection ? (
            <p>
              <strong>Link to Kevin.</strong> {note.connection}
            </p>
          ) : null}
          {note.questions.length > 0 ? (
            <div>
              <strong>Open questions.</strong>
              <ul>
                {note.questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {note.curiosity ? (
            <p className="kiosk__helper">It went looking because: {note.curiosity}</p>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function ReadingNotes({
  avatarId,
  name,
  load,
}: {
  avatarId: string;
  name: string;
  load: LoadReadingNotes;
}) {
  const [notes, setNotes] = useState<ReadingNote[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load(avatarId, READING_NOTES_SHOWN)
      .then((list) => {
        if (!cancelled) setNotes(list);
      })
      .catch((error: unknown) => {
        console.warn('Could not read the reading notes', error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarId, load]);

  return (
    <section className="readingNotes" aria-label={`Reading notes of ${name}`}>
      <h4 className="readingNotes__heading">Reading</h4>
      {failed ? (
        <p className="kiosk__helper">The notes could not be read.</p>
      ) : notes === null ? (
        <p className="kiosk__helper">Reading the notes…</p>
      ) : notes.length === 0 ? (
        <p className="kiosk__helper">
          {name} has not written any reading notes yet. When it feels like it, it reads on its own
          and writes down what it thinks.
        </p>
      ) : (
        <ul className="readingNotes__list">
          {notes.map((note) => (
            <Note key={note.id} note={note} />
          ))}
        </ul>
      )}
    </section>
  );
}
