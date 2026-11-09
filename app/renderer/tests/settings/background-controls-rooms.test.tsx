import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundControls } from '../../src/backgrounds/background-controls.js';
import { useBackgrounds } from '../../src/backgrounds/use-backgrounds.js';
import type { IdleSettings } from '../../../main/src/rooms/idle-settings.js';
import type { BackgroundBridge, BackgroundSummary } from '../../../main/src/backgrounds/types.js';
import { builtInRoom } from '../rooms/fixtures.js';

const picture = (id: string): BackgroundSummary => ({
  id,
  name: id,
  builtIn: true,
  groundY: 0.86,
  thumbnailDataUrl: 'data:image/png;base64,AA==',
});
const reading = builtInRoom('reading-room');

function Harness({ api, walkable }: { api: BackgroundBridge; walkable?: boolean }) {
  const state = useBackgrounds(api);
  return (
    <>
      <BackgroundControls
        backgrounds={state}
        walkableArea={walkable ? { shown: false, onChange: () => undefined } : undefined}
      />
      <output data-testid="kind">{state.activeKind}</output>
      <output data-testid="room">{state.activeRoom?.name ?? 'none'}</output>
      <output data-testid="image">{state.imageUrl ?? 'none'}</output>
      <output data-testid="name">{state.activeName}</output>
    </>
  );
}
function bridge(active: string | null = 'Garden'): BackgroundBridge {
  return {
    list: vi.fn().mockResolvedValue([picture('Garden')]),
    getActive: vi.fn().mockResolvedValue(active),
    setActive: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue('data:image/png;base64,AA=='),
    generate: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    listRooms: vi.fn().mockResolvedValue([
      { id: 'room:builtin:reading-room', name: 'Reading room', builtIn: true, description: reading.description },
      { id: 'room:builtin:studio-flat', name: 'Studio flat', builtIn: true, description: 'A studio.' },
    ]),
    loadRoom: vi.fn().mockResolvedValue(reading),
    getIdleSettings: vi.fn().mockResolvedValue({ enabled: true, restlessness: 'normal', onTalk: 'turn' }),
    setIdleSettings: vi.fn().mockImplementation(async (settings: IdleSettings) => settings),
  };
}

describe('3D rooms in the background controls', () => {
  it('switches to the rooms tab, hides the generate form and selects a room', async () => {
    const api = bridge();
    render(<Harness api={api} />);
    await screen.findByRole('button', { name: 'Garden' });
    expect(screen.getByLabelText('Background description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2D pictures' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '3D rooms' }));
    expect(screen.queryByLabelText('Background description')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate background' })).not.toBeInTheDocument();
    expect(screen.getByText('Describing a room to build it comes in a later update.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Reading room' }));
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith('room:builtin:reading-room'));
    await waitFor(() => expect(screen.getByTestId('room')).toHaveTextContent('Reading room'));
    expect(screen.getByTestId('kind')).toHaveTextContent('3d');
    expect(screen.getByTestId('image')).toHaveTextContent('none');
    expect(screen.getByTestId('name')).toHaveTextContent('Reading room');
    expect(screen.getByText(reading.description!)).toBeInTheDocument();
  });

  it('opens on the rooms tab when a room is the active stage', async () => {
    render(<Harness api={bridge('room:builtin:reading-room')} />);
    expect(await screen.findByRole('button', { name: 'Reading room' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '3D rooms' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Background description')).not.toBeInTheDocument();
  });

  it('only offers the walkable-area toggle when asked to', async () => {
    const { unmount } = render(<Harness api={bridge('room:builtin:reading-room')} />);
    await screen.findByRole('button', { name: 'Reading room' });
    expect(screen.queryByLabelText('Show walkable area')).not.toBeInTheDocument();
    unmount();
    render(<Harness api={bridge('room:builtin:reading-room')} walkable />);
    expect(await screen.findByLabelText('Show walkable area')).toBeInTheDocument();
  });
});

describe('When idle settings', () => {
  it('shows the defaults: wander on, normal restlessness, turn to me where it is', async () => {
    const api = bridge('room:builtin:reading-room');
    (api.getIdleSettings as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(<Harness api={api} />);
    expect(await screen.findByText('When idle')).toBeInTheDocument();
    expect(screen.getByLabelText('Wander when nobody is talking')).toBeChecked();
    expect(screen.getByLabelText('Restlessness')).toHaveValue('normal');
    expect(screen.getByLabelText('When I start talking')).toHaveValue('turn');
    expect(screen.getAllByRole('option', { name: /Calm|Normal|Restless/ }).map((option) => option.textContent)).toEqual(['Calm', 'Normal', 'Restless']);
    expect(screen.getByRole('option', { name: 'Come back to me' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Turn to me where it is' })).toBeInTheDocument();
  });

  it('only shows on the 3D rooms tab', async () => {
    render(<Harness api={bridge('Garden')} />);
    await screen.findByRole('button', { name: 'Garden' });
    expect(screen.queryByText('When idle')).not.toBeInTheDocument();
  });

  it('loads what was saved and saves every change under rooms.idle', async () => {
    const api = bridge('room:builtin:reading-room');
    (api.getIdleSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ enabled: false, restlessness: 'calm', onTalk: 'come-back' });
    render(<Harness api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Wander when nobody is talking')).not.toBeChecked());
    expect(screen.getByLabelText('Restlessness')).toHaveValue('calm');
    expect(screen.getByLabelText('When I start talking')).toHaveValue('come-back');
    expect(screen.getByLabelText('Restlessness')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Wander when nobody is talking'));
    await waitFor(() => expect(api.setIdleSettings).toHaveBeenLastCalledWith({ enabled: true, restlessness: 'calm', onTalk: 'come-back' }));
    fireEvent.change(screen.getByLabelText('Restlessness'), { target: { value: 'restless' } });
    await waitFor(() => expect(api.setIdleSettings).toHaveBeenLastCalledWith({ enabled: true, restlessness: 'restless', onTalk: 'come-back' }));
    fireEvent.change(screen.getByLabelText('When I start talking'), { target: { value: 'turn' } });
    await waitFor(() => expect(api.setIdleSettings).toHaveBeenLastCalledWith({ enabled: true, restlessness: 'restless', onTalk: 'turn' }));
    expect(screen.getByLabelText('Restlessness')).toHaveValue('restless');
  });
});
