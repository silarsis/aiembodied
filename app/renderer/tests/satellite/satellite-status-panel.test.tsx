import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';
import { evaluateGate } from '../../../main/src/satellite/device-gate.js';
import { SatelliteStatusPanel } from '../../src/satellite/satellite-status-panel.js';

const FACTS = { occupied: true, unlocked: true, linkUp: true, open: true, noFullscreenApp: true, notHeldOff: true };
const status = { paired: true, link: 'online', placeName: 'the study', hubUrl: 'http://bija:8791', deviceName: 'Desk', hostname: 'desk', lastError: null } as unknown as SatelliteStatus;
const bridge = { forget: vi.fn() } as unknown as SatelliteBridge;

describe('SatelliteStatusPanel camera', () => {
  it('says when the camera is live', () => {
    render(<SatelliteStatusPanel status={status} bridge={bridge} gate={evaluateGate({ ...FACTS, cameraEnabled: true })} />);
    expect(screen.getByTestId('satellite-camera').textContent).toContain('Live');
  });

  it('says the room setting is the reason while the mic is live and the camera is not (read-only here, set on bija)', () => {
    render(<SatelliteStatusPanel status={status} bridge={bridge} gate={evaluateGate(FACTS)} />);
    expect(screen.getByTestId('satellite-camera').textContent).toBe('Off: Camera presence is off for this room (set on bija)');
  });

  it('gives the gate\'s reason while everything is off, and plain "Off" without a gate', () => {
    const { rerender } = render(<SatelliteStatusPanel status={status} bridge={bridge} gate={evaluateGate({ ...FACTS, unlocked: false, cameraEnabled: true })} />);
    expect(screen.getByTestId('satellite-camera').textContent).toBe('Off: The screen is locked');
    rerender(<SatelliteStatusPanel status={status} bridge={bridge} gate={null} />);
    expect(screen.getByTestId('satellite-camera').textContent).toBe('Off');
  });

  it('shows why the camera could not start', () => {
    render(<SatelliteStatusPanel status={status} bridge={bridge} gate={evaluateGate({ ...FACTS, cameraEnabled: true })} cameraError="the face model is missing" />);
    expect(screen.getByTestId('satellite-camera').textContent).toContain('the face model is missing');
  });

  it('lets this PC pick its camera', () => {
    const onCameraChange = vi.fn();
    render(
      <SatelliteStatusPanel
        status={status}
        bridge={bridge}
        gate={null}
        cameras={[{ deviceId: 'cam-1', label: 'Desk camera' }]}
        selectedCamera=""
        onCameraChange={onCameraChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Camera to use'), { target: { value: 'cam-1' } });
    expect(onCameraChange).toHaveBeenCalledWith('cam-1');
  });
});

describe('SatelliteStatusPanel start at login', () => {
  it('shows "Start when I sign in" off by default and turns it on', async () => {
    const startAtLogin = vi.fn().mockResolvedValue(false);
    const setStartAtLogin = vi.fn().mockResolvedValue(true);
    render(<SatelliteStatusPanel status={status} bridge={{ forget: vi.fn(), startAtLogin, setStartAtLogin } as unknown as SatelliteBridge} gate={null} />);
    const box = (await screen.findByLabelText('Start when I sign in')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(setStartAtLogin).toHaveBeenCalledWith(true));
    await waitFor(() => expect(box.checked).toBe(true));
  });

  it('says so when Windows refused, and is not shown on a build that cannot do it', async () => {
    const refused = vi.fn().mockResolvedValue(false);
    const { unmount } = render(
      <SatelliteStatusPanel status={status} bridge={{ forget: vi.fn(), startAtLogin: vi.fn().mockResolvedValue(false), setStartAtLogin: refused } as unknown as SatelliteBridge} gate={null} />,
    );
    fireEvent.click(await screen.findByLabelText('Start when I sign in'));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not let the app change this');
    unmount();
    render(<SatelliteStatusPanel status={status} bridge={bridge} gate={null} />);
    expect(screen.queryByLabelText('Start when I sign in')).toBeNull();
  });
});
