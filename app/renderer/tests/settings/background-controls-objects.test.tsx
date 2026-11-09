import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundControls } from '../../src/backgrounds/background-controls.js';
import { useBackgrounds } from '../../src/backgrounds/use-backgrounds.js';
import type { BackgroundBridge } from '../../../main/src/backgrounds/types.js';
import type { GeneratedObjectSummary, ObjectSettingsView } from '../../../main/src/rooms/object-settings.js';
import type { RoomGenerationProgress } from '../../../main/src/rooms/room-generation.js';
import { builtInRoom } from '../rooms/fixtures.js';

const reading = builtInRoom('reading-room');
const SAVED = 'room:11111111-2222-3333-4444-555555555555';
const saved = { id: SAVED, name: 'My study', builtIn: false, description: 'A study with a desk.' };

function Harness({ api }: { api: BackgroundBridge }) {
  const state = useBackgrounds(api);
  return (
    <>
      <BackgroundControls backgrounds={state} />
      <output data-testid="room-objects">{state.activeRoom?.objects.map((o) => o.name).join(',') ?? 'none'}</output>
    </>
  );
}

const chair: GeneratedObjectSummary = { id: 'rocking-chair-3fa91c2e', name: 'rocking chair', created: '2026-11-09T10:00:00Z', imageUrl: 'aiembodied-asset://generated/rocking-chair-3fa91c2e/source.png' };
const lamp: GeneratedObjectSummary = { id: 'floor-lamp-9c1d77aa', name: 'floor lamp', created: '2026-11-08T10:00:00Z', imageUrl: 'aiembodied-asset://generated/floor-lamp-9c1d77aa/source.png' };

function bridge(options: { active?: string | null; settings?: ObjectSettingsView; generated?: GeneratedObjectSummary[]; making?: string | null } = {}) {
  let generated = options.generated ?? [];
  let settings: ObjectSettingsView = options.settings ?? { enabled: true, maxPerRoom: 3, available: true };
  const listeners = { progress: undefined as ((p: RoomGenerationProgress) => void) | undefined, updated: undefined as ((id: string) => void) | undefined };
  const api: BackgroundBridge = {
    list: vi.fn().mockResolvedValue([]),
    getActive: vi.fn().mockResolvedValue('active' in options ? options.active : 'room:builtin:reading-room'),
    setActive: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(''),
    generate: vi.fn(),
    delete: vi.fn(),
    listRooms: vi.fn().mockResolvedValue([{ id: 'room:builtin:reading-room', name: 'Reading room', builtIn: true }, saved]),
    loadRoom: vi.fn().mockResolvedValue(reading),
    getIdleSettings: vi.fn().mockResolvedValue({ enabled: true, restlessness: 'normal', onTalk: 'turn' }),
    setIdleSettings: vi.fn(),
    getObjectSettings: vi.fn().mockImplementation(async () => settings),
    setObjectSettings: vi.fn().mockImplementation(async (patch: Partial<ObjectSettingsView>) => (settings = { ...settings, ...patch })),
    listGeneratedObjects: vi.fn().mockImplementation(async () => generated),
    deleteGeneratedObject: vi.fn().mockImplementation(async (id: string) => {
      generated = generated.filter((g) => g.id !== id);
    }),
    getMakingRoom: vi.fn().mockResolvedValue(options.making ?? null),
    generateRoom: vi.fn(),
    cancelRoomGeneration: vi.fn().mockResolvedValue(true),
    onRoomProgress: vi.fn().mockImplementation((l: (p: RoomGenerationProgress) => void) => {
      listeners.progress = l;
      return () => undefined;
    }),
    onRoomUpdated: vi.fn().mockImplementation((l: (id: string) => void) => {
      listeners.updated = l;
      return () => undefined;
    }),
  };
  return { api, listeners };
}

describe('Make missing objects', () => {
  it('shows the defaults, on and three per room, and saves each change', async () => {
    const { api } = bridge();
    render(<Harness api={api} />);
    const checkbox = await screen.findByLabelText('Make missing objects');
    expect(checkbox).toBeChecked();
    const limit = screen.getByLabelText('At most this many per room');
    expect(limit).toHaveValue(3);
    expect(limit).toHaveAttribute('min', '0');
    expect(limit).toHaveAttribute('max', '8');

    fireEvent.change(limit, { target: { value: '5' } });
    await waitFor(() => expect(api.setObjectSettings).toHaveBeenLastCalledWith({ maxPerRoom: 5 }));
    await waitFor(() => expect(screen.getByLabelText('At most this many per room')).toHaveValue(5));
    fireEvent.change(limit, { target: { value: '12' } });
    await waitFor(() => expect(api.setObjectSettings).toHaveBeenLastCalledWith({ maxPerRoom: 8 }));
    fireEvent.change(limit, { target: { value: '-3' } });
    await waitFor(() => expect(api.setObjectSettings).toHaveBeenLastCalledWith({ maxPerRoom: 0 }));
    fireEvent.click(checkbox);
    await waitFor(() => expect(api.setObjectSettings).toHaveBeenLastCalledWith({ enabled: false }));
    await waitFor(() => expect(screen.getByLabelText('At most this many per room')).toBeDisabled());
  });

  it('is hidden, with a hint, when the image and 3D steps are not set up', async () => {
    const { api } = bridge({ settings: { enabled: true, maxPerRoom: 3, available: false } });
    render(<Harness api={api} />);
    expect(await screen.findByText(/set up a ComfyUI server/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Make missing objects')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('At most this many per room')).not.toBeInTheDocument();
  });

  it('only shows on the 3D rooms tab', async () => {
    const { api } = bridge({ active: null });
    render(<Harness api={api} />);
    await screen.findByRole('button', { name: '3D rooms' });
    expect(screen.queryByLabelText('Make missing objects')).not.toBeInTheDocument();
  });
});

describe('Objects being made in the background', () => {
  it('shows progress and a spinner on the saved room, and notes when it is done', async () => {
    const { api, listeners } = bridge();
    let finish!: (value: unknown) => void;
    (api.generateRoom as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness api={api} />);
    fireEvent.change(await screen.findByLabelText('Room description'), { target: { value: 'A study with a desk.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Build room' }));
    finish({ room: saved, warnings: ["Couldn't find a rug, used a simple shape."], making: 3 });

    expect(await screen.findByText("Couldn't find a rug, used a simple shape.")).toBeInTheDocument();
    act(() => listeners.progress?.({ phase: 'making', roomId: SAVED, message: 'Making the rocking chair (1/3)…' }));
    expect(await screen.findByText('Making the rocking chair (1/3)…')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Making new objects for My study' })).toBeInTheDocument();
    // One room at a time, background objects included.
    expect(screen.getByRole('button', { name: 'Making objects…' })).toBeDisabled();
    expect(screen.getByLabelText('Room description')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelRoomGeneration).toHaveBeenCalled();

    act(() => listeners.progress?.({ phase: 'done', roomId: SAVED, message: 'Done, with notes', warnings: ['Made a new model for the rocking chair.', "Couldn't make a desk, used a simple shape."] }));
    expect(await screen.findByText('Made a new model for the rocking chair.')).toBeInTheDocument();
    expect(screen.getByText("Couldn't make a desk, used a simple shape.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't find a rug, used a simple shape.")).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /Making new objects/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build room' })).toBeEnabled();
  });

  it('picks up a build that is already under way when the pop-up opens', async () => {
    const { api } = bridge({ making: SAVED });
    render(<Harness api={api} />);
    expect(await screen.findByRole('status', { name: 'Making new objects for My study' })).toBeInTheDocument();
    expect(screen.getByLabelText('Room description')).toBeDisabled();
  });

  it('reloads the room when one of its objects was made, if it is the one on stage', async () => {
    const { api, listeners } = bridge({ active: SAVED });
    const updated = { ...reading, objects: [{ ...reading.objects[0], name: 'new rocking chair' }] };
    render(<Harness api={api} />);
    await waitFor(() => expect(screen.getByTestId('room-objects')).toHaveTextContent(reading.objects[0].name));
    (api.loadRoom as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

    // Another room's file changing is not the stage's business.
    act(() => listeners.updated?.('room:other'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('room-objects')).toHaveTextContent(reading.objects[0].name);
    act(() => listeners.updated?.(SAVED));
    await waitFor(() => expect(screen.getByTestId('room-objects')).toHaveTextContent('new rocking chair'));
    expect(api.loadRoom).toHaveBeenCalledWith(SAVED);
    expect((api.listGeneratedObjects as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});

describe('Generated objects', () => {
  it('lists each with its picture and deletes the one asked for', async () => {
    const { api } = bridge({ generated: [chair, lamp] });
    render(<Harness api={api} />);
    const list = await screen.findByRole('list', { name: 'Generated objects' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['rocking chairDelete', 'floor lampDelete']);
    expect(items[0].querySelector('img')).toHaveAttribute('src', chair.imageUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Delete generated rocking chair' }));
    await waitFor(() => expect(api.deleteGeneratedObject).toHaveBeenCalledWith(chair.id));
    await waitFor(() => expect(screen.queryByText('rocking chair')).not.toBeInTheDocument());
    expect(screen.getByText('floor lamp')).toBeInTheDocument();
  });

  it('reloads the active room after a delete, so it shows a simple shape', async () => {
    const { api } = bridge({ active: SAVED, generated: [chair] });
    render(<Harness api={api} />);
    await screen.findByRole('button', { name: 'Delete generated rocking chair' });
    await waitFor(() => expect(screen.getByTestId('room-objects')).toHaveTextContent(reading.objects[0].name));
    (api.loadRoom as ReturnType<typeof vi.fn>).mockResolvedValue({ ...reading, objects: [{ ...reading.objects[0], name: 'simple chair' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete generated rocking chair' }));
    await waitFor(() => expect(screen.getByTestId('room-objects')).toHaveTextContent('simple chair'));
  });

  it('is not shown when nothing has been made', async () => {
    const { api } = bridge();
    render(<Harness api={api} />);
    await screen.findByLabelText('Make missing objects');
    expect(screen.queryByText('Generated objects')).not.toBeInTheDocument();
  });
});
