import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RoomHubBridge, RoomHubStatus } from '../../../main/src/room-hub/bridge-types.js';
import { RoomDevicesStatus, deviceSummary } from '../../src/places/room-devices-status.js';

const STATE = { mic: 'live', camera: 'off', speakers: 'live', locked: false, closed: false, fullscreen: false };

describe('deviceSummary', () => {
  it('says what the PC reported, and why when it is off', () => {
    expect(deviceSummary(null)).toBe('Devices: not reported yet');
    expect(deviceSummary(STATE)).toBe('Mic live, camera off');
    expect(deviceSummary({ ...STATE, mic: 'doorbell' })).toBe('Mic doorbell only, camera off');
    expect(deviceSummary({ ...STATE, mic: 'off', locked: true })).toBe('Mic off, camera off · screen locked');
    expect(deviceSummary({ ...STATE, mic: 'off', closed: true })).toBe('Mic off, camera off · room closed');
    expect(deviceSummary({ ...STATE, mic: 'off', fullscreen: true })).toContain('full-screen app');
  });
});

describe('RoomDevicesStatus', () => {
  const status = (online: boolean): RoomHubStatus => ({
    running: true,
    port: 8791,
    addresses: [],
    pairing: null,
    devices: [{ id: 'd1', name: 'Study PC', placeId: 'study', online, lastSeen: 0, tailscaleNode: null, deviceState: STATE }],
  });

  it('lists each desktop room with its mic and camera, and follows pushes', async () => {
    let push: (next: RoomHubStatus) => void = () => undefined;
    const roomHub = {
      status: vi.fn(async () => status(true)),
      onChanged: vi.fn((listener: (next: RoomHubStatus) => void) => {
        push = listener;
        return () => undefined;
      }),
    } as unknown as RoomHubBridge;
    render(<RoomDevicesStatus roomHub={roomHub} active />);
    expect(await screen.findByTestId('room-devices-study')).toHaveTextContent('Study PC: Mic live, camera off');
    push({ ...status(true), devices: [{ ...status(true).devices[0], deviceState: { ...STATE, mic: 'off', locked: true } }] });
    await waitFor(() => expect(screen.getByTestId('room-devices-study')).toHaveTextContent('screen locked'));
  });

  it('shows nothing without rooms or when not active', () => {
    const { container } = render(<RoomDevicesStatus roomHub={undefined} active />);
    expect(container).toBeEmptyDOMElement();
  });
});
