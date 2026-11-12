import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SceneCast } from '../../src/avatar/scene-cast.js';

const echo = { id: 'echo', name: 'Echo', vrmModelId: 'm1' };
const sage = { id: 'sage', name: 'Sage', vrmModelId: null, prompt: 'Be calm.' };
const luna = { id: 'luna', name: 'Luna', vrmModelId: 'm2' };
const models = [
  { id: 'm1', name: 'Body One', thumbnailDataUrl: 'data:image/png;base64,AAA' },
  { id: 'm2', name: 'Body Two', thumbnailDataUrl: null },
  { id: 'm3', name: 'Body Three', thumbnailDataUrl: 'data:image/png;base64,BBB' },
];

function makeApi() {
  return {
    list: vi.fn(async () => [echo, sage]),
    add: vi.fn(async (input: { name: string }) => ({ id: 'x', name: input.name, vrmModelId: null })),
    update: vi.fn(async (id: string, changes: object) => ({ ...sage, id, ...changes })),
    remove: vi.fn(async () => undefined),
  };
}

describe('SceneCast', () => {
  it('shows a card per profile in order, the Host badge and who shares Echo\'s body', () => {
    render(<SceneCast api={makeApi()} profiles={[echo, sage, luna]} models={models} />);
    expect(screen.getByRole('heading', { name: 'In the scene' })).toBeInTheDocument();
    expect(screen.getByText(/Echo is the host and answers when no one is named/)).toBeInTheDocument();
    const cards = within(screen.getByRole('list', { name: 'Characters in the scene' })).getAllByRole('listitem');
    expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual(['scene-card-echo', 'scene-card-sage', 'scene-card-luna']);
    expect(within(cards[0]).getByText('Host')).toBeInTheDocument();
    expect(within(cards[1]).queryByText('Host')).toBeNull();
    expect(within(cards[1]).getByText("Shares Echo's body")).toBeInTheDocument();
    expect(within(cards[0]).queryByText("Shares Echo's body")).toBeNull();
    expect(within(cards[2]).queryByText("Shares Echo's body")).toBeNull();
    expect(cards[0].querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(cards[2].querySelector('img')).toBeNull();
  });

  it('adds a library character in one click, then refreshes', async () => {
    const api = makeApi();
    const onChanged = vi.fn();
    render(<SceneCast api={api} profiles={[echo]} models={models} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Body Two to scene' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ name: 'Body Two', vrmModelId: 'm2' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers only library characters nobody in the scene wears', () => {
    const { rerender } = render(<SceneCast api={makeApi()} profiles={[echo, luna]} models={models} />);
    const tiles = within(screen.getByRole('list', { name: 'Characters you can add' }));
    expect(tiles.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add Body Three to scene']);
    rerender(<SceneCast api={makeApi()} profiles={[echo, luna, { id: 'r', name: 'R', vrmModelId: 'm3' }]} models={models} />);
    expect(screen.queryByRole('list', { name: 'Characters you can add' })).toBeNull();
    expect(screen.getByText(/already in the scene/)).toBeInTheDocument();
  });

  it('adds by name, with an optional prompt, and clears the form', async () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo]} models={[]} />);
    fireEvent.change(screen.getByLabelText('New character name'), { target: { value: ' Rex ' } });
    fireEvent.change(screen.getByLabelText('New character prompt'), { target: { value: 'Be bold.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add character' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ name: 'Rex', prompt: 'Be bold.' }));
    await waitFor(() => expect((screen.getByLabelText('New character name') as HTMLInputElement).value).toBe(''));
    fireEvent.change(screen.getByLabelText('New character name'), { target: { value: 'Pip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add character' }));
    await waitFor(() => expect(api.add).toHaveBeenLastCalledWith({ name: 'Pip' }));
  });

  it('asks for a name before adding by name', () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo]} models={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add character' }));
    expect(screen.getByRole('alert').textContent).toBe('Give the character a name.');
    expect(api.add).not.toHaveBeenCalled();
  });

  it('edits name, body and prompt (empty clears it)', async () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} />);
    expect(screen.queryByLabelText('Name of Sage')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
    const name = screen.getByLabelText('Name of Sage');
    fireEvent.change(name, { target: { value: 'Sagey' } });
    fireEvent.blur(name);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { name: 'Sagey' }));
    fireEvent.change(screen.getByLabelText('Body of Sage'), { target: { value: 'm3' } });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { vrmModelId: 'm3' }));
    fireEvent.change(screen.getByLabelText('Body of Sage'), { target: { value: '' } });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { vrmModelId: null }));
    expect(screen.getByText("Used when this character's body has no saved personality of its own.")).toBeInTheDocument();
    const prompt = screen.getByLabelText('Prompt of Sage');
    fireEvent.change(prompt, { target: { value: '' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { prompt: '' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
    expect(screen.queryByLabelText('Name of Sage')).toBeNull();
  });

  it('does not save an unchanged or blank name', () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
    const name = screen.getByLabelText('Name of Sage') as HTMLInputElement;
    fireEvent.change(name, { target: { value: '  ' } });
    fireEvent.blur(name);
    expect(api.update).not.toHaveBeenCalled();
    expect(name.value).toBe('Sage');
  });

  it('locks Echo\'s body and explains why', () => {
    render(<SceneCast api={makeApi()} profiles={[echo, sage]} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Echo' }));
    expect(screen.getByLabelText('Body of Echo')).toBeDisabled();
    expect(screen.getByText('Echo wears the active character picked below.')).toBeInTheDocument();
  });

  it('confirms before removing, and Echo has no Remove', async () => {
    const api = makeApi();
    const onChanged = vi.fn();
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} onChanged={onChanged} />);
    expect(screen.queryByRole('button', { name: 'Remove Echo from the scene' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sage from the scene' }));
    expect(screen.getByText('Remove Sage from the scene?')).toBeInTheDocument();
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel removing Sage' }));
    expect(screen.queryByText('Remove Sage from the scene?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sage from the scene' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Sage' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('sage'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows a readable error', async () => {
    const api = makeApi();
    api.remove.mockRejectedValueOnce(new Error("Error invoking remote method 'avatars:remove': Error: Cannot remove the last avatar."));
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sage from the scene' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Sage' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot remove the last avatar.');
  });

  it('notes that others stand beside Echo when a room is active with 2+ avatars', () => {
    const { rerender } = render(<SceneCast api={makeApi()} profiles={[echo, sage]} models={models} roomActive />);
    expect(screen.getByRole('note').textContent).toContain('every avatar walks, gestures, keeps clear of the others and wanders when idle');
    rerender(<SceneCast api={makeApi()} profiles={[echo]} models={models} roomActive />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('renders nothing without the bridge', () => {
    const { container, rerender } = render(<SceneCast profiles={[]} models={[]} />);
    expect(container.firstChild).toBeNull();
    rerender(<SceneCast api={{} as never} profiles={[]} models={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
