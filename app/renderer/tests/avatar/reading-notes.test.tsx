import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadingNote } from '../../../main/src/shared/pursuits/types.js';
import { ReadingNotes } from '../../src/avatar/reading-notes.js';
import { SceneCast } from '../../src/avatar/scene-cast.js';
import type { CharacterSettingsContext } from '../../src/avatar/use-character-settings.js';

const note = (overrides: Partial<ReadingNote> = {}): ReadingNote => ({
  id: 'n1',
  avatarId: 'sage',
  stationId: 's1',
  title: 'Memory for Agents',
  link: 'https://academy.example/p/1',
  takeaway: 'Forgetting matters.',
  opinion: 'Convincing.',
  connection: 'Kevin builds a memory engine.',
  questions: ['How does it fade?'],
  curiosity: 'I wanted to know about memory.',
  partial: false,
  createdAt: Date.UTC(2026, 10, 16, 9, 0),
  ...overrides,
});

describe('ReadingNotes', () => {
  it('lists the notes with title, date and takeaway, and the full notes when opened', async () => {
    const load = vi.fn(async () => [
      note(),
      note({ id: 'n2', title: 'Half read', partial: true, link: null, opinion: '', questions: [] }),
    ]);
    render(<ReadingNotes avatarId="sage" name="Sage" load={load} />);
    const items = await screen.findAllByTestId('reading-note');
    expect(load).toHaveBeenCalledWith('sage', 10);
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.readingNote__title')?.textContent).toBe('Memory for Agents');
    expect(within(items[0]).getAllByText(/Forgetting matters/).length).toBeGreaterThan(0);
    expect(within(items[1]).getByText(/cut short/)).toBeInTheDocument();
    // The full notes are inside the details: link, opinion, link to Kevin, open questions.
    const link = within(items[0]).getByRole('link', { name: 'Memory for Agents' });
    expect(link).toHaveAttribute('href', 'https://academy.example/p/1');
    expect(within(items[0]).getByText(/Convincing/)).toBeInTheDocument();
    expect(within(items[0]).getByText(/Kevin builds a memory engine/)).toBeInTheDocument();
    expect(within(items[0]).getByText('How does it fade?')).toBeInTheDocument();
    expect(within(items[1]).queryByRole('link')).toBeNull();
  });

  it('says so when there are no notes, and when they cannot be read', async () => {
    const { unmount } = render(<ReadingNotes avatarId="sage" name="Sage" load={async () => []} />);
    expect(
      await screen.findByText(/Sage has not written any reading notes yet/),
    ).toBeInTheDocument();
    unmount();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <ReadingNotes
        avatarId="sage"
        name="Sage"
        load={async () => Promise.reject(new Error('down'))}
      />,
    );
    expect(await screen.findByText('The notes could not be read.')).toBeInTheDocument();
  });

  it('only makes web addresses into links', async () => {
    render(
      <ReadingNotes
        avatarId="sage"
        name="Sage"
        load={async () => [note({ link: 'javascript:alert(1)' })]}
      />,
    );
    await screen.findByTestId('reading-note');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the Reading section of a character card', () => {
  const echo = { id: 'echo', name: 'Echo', vrmModelId: 'm1' };
  const sage = { id: 'sage', name: 'Sage', vrmModelId: null };
  const api = { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() } as never;
  const context = (readingNotes?: CharacterSettingsContext['readingNotes']) =>
    ({
      isLocalBackend: true,
      realtimeVoices: [],
      readingNotes,
      echo: {} as never,
    }) as CharacterSettingsContext;

  it('shows each character its own notes', async () => {
    const readingNotes = vi.fn(async (avatarId: string) => [
      note({ avatarId, title: `${avatarId} paper` }),
    ]);
    render(
      <SceneCast api={api} profiles={[echo, sage]} models={[]} settings={context(readingNotes)} />,
    );
    await waitFor(() => expect(readingNotes).toHaveBeenCalledTimes(2));
    expect(
      within(screen.getByTestId('scene-card-echo')).getAllByText('echo paper').length,
    ).toBeGreaterThan(0);
    expect(
      within(screen.getByTestId('scene-card-sage')).getAllByText('sage paper').length,
    ).toBeGreaterThan(0);
    // Read-only: no edit controls in the section.
    expect(
      within(screen.getByLabelText('Reading notes of Sage')).queryByRole('textbox'),
    ).toBeNull();
  });

  it('leaves the section out when the app has no notes to read', () => {
    render(<SceneCast api={api} profiles={[echo]} models={[]} settings={context(undefined)} />);
    expect(screen.queryByText('Reading')).toBeNull();
  });
});
