import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacesSnapshot } from '../../../main/src/places/place-manager.js';
import type { RoomHubBridge, RoomHubStatus } from '../../../main/src/room-hub/bridge-types.js';
import { PlacesPanel } from '../../src/places/places-panel.js';

const SNAPSHOT: PlacesSnapshot = {
  places: [
    { id: 'home', name: 'the lounge', node: 'local' },
    { id: 'next-door', name: 'next door', node: 'offscreen' },
    { id: 'study', name: 'the study', node: 'room-1', online: true },
  ],
  locations: { echo: 'home', sage: 'study', rex: 'next-door' },
  transit: [],
  localPlaceId: 'home',
};

const STATUS: RoomHubStatus = {
  running: true,
  port: 8791,
  addresses: ['127.0.0.1', '100.64.0.1'],
  pairing: null,
  devices: [{ id: 'room-1', name: "Kevin's desk", placeId: 'study', online: true, lastSeen: 1_000, tailscaleNode: 'desk' }],
};

function bridge(overrides: Partial<RoomHubBridge> = {}) {
  let listener: ((status: RoomHubStatus) => void) | null = null;
  const api = {
    status: vi.fn().mockResolvedValue(STATUS),
    onChanged: vi.fn((next: (status: RoomHubStatus) => void) => {
      listener = next;
      return () => undefined;
    }),
    startPairing: vi.fn().mockResolvedValue({ code: '123456', expiresAt: Date.now() + 5 * 60_000, urls: ['http://bija:8791', 'http://100.64.0.1:8791'] }),
    cancelPairing: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(true),
    rename: vi.fn().mockResolvedValue(null),
    ...overrides,
  } satisfies RoomHubBridge;
  return { api, push: (status: RoomHubStatus) => act(() => listener?.(status)) };
}

const nameOf = (id: string) => ({ echo: 'Echo', sage: 'Sage', rex: 'Rex' })[id] ?? id;

describe('PlacesPanel', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('lists every place with its kind, online dot and who is there', async () => {
    const { api } = bridge();
    render(<PlacesPanel roomHub={api} snapshot={SNAPSHOT} nameOf={nameOf} active />);
    const lounge = screen.getByRole('listitem', { name: 'the lounge' });
    expect(lounge).toHaveTextContent('This PC');
    expect(lounge).toHaveTextContent('Here: Echo');
    expect(screen.getByRole('listitem', { name: 'next door' })).toHaveTextContent('Next door');
    const study = screen.getByRole('listitem', { name: 'the study' });
    expect(study).toHaveTextContent('Desktop room');
    expect(study).toHaveTextContent('Here: Sage');
    expect(within(study).getByRole('img', { name: 'Online' })).toBeInTheDocument();
    await waitFor(() => expect(study).toHaveTextContent("Kevin's desk · connected"));
  });

  it('shows an offline room with its last-seen time, and revokes it', async () => {
    const offline: RoomHubStatus = { ...STATUS, devices: [{ ...STATUS.devices[0], online: false }] };
    const snapshot: PlacesSnapshot = { ...SNAPSHOT, places: SNAPSHOT.places.map((place) => (place.id === 'study' ? { ...place, online: false } : place)) };
    const { api } = bridge({ status: vi.fn().mockResolvedValue(offline) });
    render(<PlacesPanel roomHub={api} snapshot={snapshot} nameOf={nameOf} active />);
    const study = screen.getByRole('listitem', { name: 'the study' });
    expect(within(study).getByRole('img', { name: 'Offline' })).toBeInTheDocument();
    await waitFor(() => expect(study).toHaveTextContent('last seen'));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke the study' }));
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('room-1'));
  });

  it('renames a place when the name field loses focus', async () => {
    const { api } = bridge();
    render(<PlacesPanel roomHub={api} snapshot={SNAPSHOT} nameOf={nameOf} active />);
    const field = screen.getByLabelText('Name of the study');
    fireEvent.change(field, { target: { value: 'the attic' } });
    fireEvent.blur(field);
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('study', 'the attic'));
    // An unchanged or empty name is not sent.
    vi.mocked(api.rename).mockClear();
    const other = screen.getByLabelText('Name of next door');
    fireEvent.change(other, { target: { value: '  ' } });
    fireEvent.blur(other);
    expect(api.rename).not.toHaveBeenCalled();
  });

  it('adds a desktop room: asks for the name, shows the code, countdown and addresses, and can cancel', async () => {
    const { api } = bridge();
    render(<PlacesPanel roomHub={api} snapshot={SNAPSHOT} nameOf={nameOf} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a desktop room' }));
    const name = screen.getByLabelText('Name of the room');
    expect(name).toHaveValue('the study');
    fireEvent.change(name, { target: { value: 'the attic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    await waitFor(() => expect(api.startPairing).toHaveBeenCalledWith('the attic'));
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('123456');
    expect(screen.getByText(/Valid for 5:00|Valid for 4:59/)).toBeInTheDocument();
    expect(screen.getByText('http://bija:8791')).toBeInTheDocument();
    expect(screen.getByText('http://100.64.0.1:8791')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.cancelPairing).toHaveBeenCalled());
    expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a desktop room' })).toBeInTheDocument();
  });

  it('counts down and says when the code has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = bridge({
      startPairing: vi.fn().mockResolvedValue({ code: '654321', expiresAt: Date.now() + 3000, urls: [] }),
    });
    render(<PlacesPanel roomHub={api} snapshot={SNAPSHOT} nameOf={nameOf} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a desktop room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('654321');
    expect(screen.getByText(/No Tailscale address/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
    expect(screen.getByText('That code has expired.')).toBeInTheDocument();
  });

  it('drops the code when the other PC has paired', async () => {
    const { api, push } = bridge();
    render(<PlacesPanel roomHub={api} snapshot={SNAPSHOT} nameOf={nameOf} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a desktop room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    await screen.findByLabelText('Pairing code');
    push({ ...STATUS, pairing: { code: '123456', expiresAt: Date.now() + 1000, placeName: null } });
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
    push({ ...STATUS, pairing: null });
    expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
    expect(screen.getByText('The other PC is paired.')).toBeInTheDocument();
  });

  it('says so when the app build has no desktop rooms', () => {
    render(<PlacesPanel snapshot={SNAPSHOT} nameOf={nameOf} active />);
    expect(screen.getByText('Desktop rooms need a newer app build.')).toBeInTheDocument();
  });

  it('shows errors from the main process', async () => {
    const { api } = bridge({ startPairing: vi.fn().mockRejectedValue(new Error('Port is busy')) });
    render(<PlacesPanel roomHub={api} snapshot={SNAPSHOT} nameOf={nameOf} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a desktop room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Port is busy');
  });
});

describe('PlacesPanel room choice', () => {
  const snapshot: PlacesSnapshot = {
    ...SNAPSHOT,
    places: [
      { id: 'home', name: 'the lounge', node: 'local' },
      { id: 'study', name: 'the study', node: 'room-1', online: true, room: 'room:builtin:studio-flat' },
    ],
  };

  it('offers the rooms on desktop rooms only and saves the pick', async () => {
    const setRoom = vi.fn().mockResolvedValue(null);
    const { api } = bridge({ setRoom });
    render(
      <PlacesPanel
        roomHub={api}
        snapshot={snapshot}
        nameOf={nameOf}
        active
        roomChoices={[
          { id: 'room:builtin:studio-flat', name: 'Studio', kind: '3D room' },
          { id: 'cabin', name: 'Cabin', kind: 'Background' },
        ]}
      />,
    );
    expect(screen.queryByLabelText('Room shown in the lounge')).toBeNull();
    const select = screen.getByLabelText('Room shown in the study');
    expect(select).toHaveValue('room:builtin:studio-flat');
    fireEvent.change(select, { target: { value: 'cabin' } });
    await waitFor(() => expect(setRoom).toHaveBeenCalledWith('study', 'cabin'));
  });

  it('shows Camera presence for this PC (off by default) and for a desktop room (on by default), and saves a change', async () => {
    const setCamera = vi.fn().mockResolvedValue(true);
    const { api } = bridge({ setCamera });
    render(<PlacesPanel roomHub={api} snapshot={SNAPSHOT} nameOf={nameOf} active />);
    const here = screen.getByRole('checkbox', { name: 'Camera presence in the lounge' }) as HTMLInputElement;
    const study = screen.getByRole('checkbox', { name: 'Camera presence in the study' }) as HTMLInputElement;
    expect(here.checked).toBe(false);
    expect(study.checked).toBe(true);
    // Nothing to film next door.
    expect(screen.queryByRole('checkbox', { name: 'Camera presence in next door' })).toBeNull();
    fireEvent.click(here);
    await waitFor(() => expect(setCamera).toHaveBeenCalledWith('home', true));
    fireEvent.click(study);
    await waitFor(() => expect(setCamera).toHaveBeenCalledWith('study', false));
  });

  it('shows what Kevin saved, and cannot change it when the bridge has no setCamera', () => {
    const saved: PlacesSnapshot = { ...SNAPSHOT, places: SNAPSHOT.places.map((place) => (place.id === 'home' ? { ...place, camera: true } : place.id === 'study' ? { ...place, camera: false } : place)) };
    const { api } = bridge();
    render(<PlacesPanel roomHub={api} snapshot={saved} nameOf={nameOf} active />);
    expect((screen.getByRole('checkbox', { name: 'Camera presence in the lounge' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Camera presence in the study' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'Camera presence in the lounge' })).toBeDisabled();
  });
});
