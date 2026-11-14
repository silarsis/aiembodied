import { fireEvent, render, screen } from '@testing-library/react';
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
