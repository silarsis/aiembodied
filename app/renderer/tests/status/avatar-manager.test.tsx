import { fireEvent, render, screen, waitFor, within as rtlWithin } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AvatarManager } from '../../src/status/avatar-manager.js';

const echo = { id: 'echo', name: 'Echo', vrmModelId: 'm1' };
const sage = { id: 'sage', name: 'Sage', vrmModelId: null, prompt: 'Be calm.' };
const models = [{ id: 'm1', name: 'Body One' }, { id: 'm2', name: 'Body Two' }];

function makeApi() {
  return {
    list: vi.fn(async () => [echo, sage]),
    add: vi.fn(async (input: { name: string }) => ({ id: 'x', name: input.name, vrmModelId: null })),
    update: vi.fn(async (id: string, changes: object) => ({ ...sage, id, ...changes })),
    remove: vi.fn(async () => undefined),
  };
}

describe('AvatarManager', () => {
  it('adds an avatar with a body and prompt, then refreshes', async () => {
    const api = makeApi();
    const onChanged = vi.fn();
    render(<AvatarManager api={api} profiles={[echo]} models={models} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText('New avatar name'), { target: { value: ' Rex ' } });
    fireEvent.change(screen.getByLabelText('New avatar body'), { target: { value: 'm2' } });
    fireEvent.change(screen.getByLabelText('New avatar prompt'), { target: { value: 'Be bold.' } });
    fireEvent.click(screen.getByText('Add avatar'));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ name: 'Rex', vrmModelId: 'm2', prompt: 'Be bold.' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText('New avatar name') as HTMLInputElement).value).toBe(''));
  });

  it('renames, changes body, edits and clears the prompt', async () => {
    const api = makeApi();
    render(<AvatarManager api={api} profiles={[echo, sage]} models={models} />);
    const name = screen.getByLabelText('Name of Sage');
    fireEvent.change(name, { target: { value: 'Sagey' } });
    fireEvent.blur(name);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { name: 'Sagey' }));
    fireEvent.change(screen.getByLabelText('Body of Sage'), { target: { value: 'm2' } });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { vrmModelId: 'm2' }));
    fireEvent.click(rtlWithin(screen.getByTestId('avatar-row-sage')).getByText('Prompt'));
    const prompt = screen.getByLabelText('Prompt of Sage');
    fireEvent.change(prompt, { target: { value: '' } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { prompt: '' }));
  });

  it('confirms before removing, and Echo has no Remove', async () => {
    const api = makeApi();
    render(<AvatarManager api={api} profiles={[echo, sage]} models={models} />);
    expect(screen.getAllByText('Remove')).toHaveLength(1);
    fireEvent.click(screen.getByText('Remove'));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm remove'));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('sage'));
  });

  it('shows a readable error', async () => {
    const api = makeApi();
    api.remove.mockRejectedValueOnce(new Error("Error invoking remote method 'avatars:remove': Error: Cannot remove the last avatar."));
    render(<AvatarManager api={api} profiles={[echo, sage]} models={models} />);
    fireEvent.click(screen.getByText('Remove'));
    fireEvent.click(screen.getByText('Confirm remove'));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot remove the last avatar.');
  });

  it('notes that rooms show only Echo when a room is active with 2+ avatars', () => {
    const { rerender } = render(<AvatarManager api={makeApi()} profiles={[echo, sage]} models={models} roomActive />);
    expect(screen.getByRole('note').textContent).toContain('Rooms show only Echo for now');
    rerender(<AvatarManager api={makeApi()} profiles={[echo]} models={models} roomActive />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('renders nothing without the bridge', () => {
    const { container } = render(<AvatarManager profiles={[]} models={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
