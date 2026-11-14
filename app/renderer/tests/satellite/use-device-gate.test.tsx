import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceGateBridge, DeviceGateState } from '../../../main/src/satellite/bridge-types.js';
import { evaluateGate } from '../../../main/src/satellite/device-gate.js';
import { useDeviceGate } from '../../src/satellite/use-device-gate.js';
import { DeviceDots } from '../../src/satellite/device-dots.js';

const FACTS = { occupied: true, unlocked: true, linkUp: true, open: true, noFullscreenApp: true, notHeldOff: true };
const WITH_CAMERA = { ...FACTS, cameraEnabled: true };

function Probe({ bridge, onClose }: { bridge: DeviceGateBridge; onClose: (scope: { audio: boolean; camera: boolean }) => Promise<void> | void }) {
  const state = useDeviceGate(bridge, onClose);
  return <p>{state?.mic ?? 'unknown'}</p>;
}

function fakeBridge(first: DeviceGateState) {
  let push: (state: DeviceGateState) => void = () => undefined;
  const order: string[] = [];
  const bridge: DeviceGateBridge = {
    get: vi.fn(async () => first),
    onChanged: (listener) => {
      push = listener;
      return () => undefined;
    },
    captureStopped: vi.fn(async () => void order.push('confirmed')),
    setOpen: vi.fn(async () => first),
  };
  return { bridge, order, push: (state: DeviceGateState) => act(async () => push(state)) };
}

describe('useDeviceGate', () => {
  it('stops capture first and only then confirms it, when the gate closes', async () => {
    const { bridge, order, push } = fakeBridge(evaluateGate(FACTS));
    const onClose = vi.fn(async () => void order.push('stopped'));
    render(<Probe bridge={bridge} onClose={onClose} />);
    await waitFor(() => expect(bridge.get).toHaveBeenCalled());
    await push(evaluateGate({ ...FACTS, unlocked: false }));
    await waitFor(() => expect(order).toEqual(['stopped', 'confirmed']));
  });

  it('still confirms when stopping fails (main reloads the page otherwise)', async () => {
    const { bridge, push } = fakeBridge(evaluateGate(FACTS));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Probe bridge={bridge} onClose={() => Promise.reject(new Error('stuck'))} />);
    await push(evaluateGate({ ...FACTS, linkUp: false }));
    await waitFor(() => expect(bridge.captureStopped).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('stops audio and camera together when the whole gate closes', async () => {
    const { bridge, push } = fakeBridge(evaluateGate(WITH_CAMERA));
    const onClose = vi.fn();
    render(<Probe bridge={bridge} onClose={onClose} />);
    await waitFor(() => expect(bridge.get).toHaveBeenCalled());
    await push(evaluateGate({ ...WITH_CAMERA, linkUp: false }));
    expect(onClose).toHaveBeenCalledWith({ audio: true, camera: true });
  });

  it('stops only the camera when its setting goes off while the mic stays live, and confirms', async () => {
    const { bridge, order, push } = fakeBridge(evaluateGate(WITH_CAMERA));
    const onClose = vi.fn(async () => void order.push('stopped'));
    render(<Probe bridge={bridge} onClose={onClose} />);
    await waitFor(() => expect(bridge.get).toHaveBeenCalled());
    await push(evaluateGate(FACTS));
    expect(onClose).toHaveBeenCalledWith({ audio: false, camera: true });
    await waitFor(() => expect(order).toEqual(['stopped', 'confirmed']));
    // A later push with the camera still off has nothing more to stop.
    await push(evaluateGate(FACTS));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not stop anything while the gate stays open', async () => {
    const { bridge, push } = fakeBridge(evaluateGate(FACTS));
    const onClose = vi.fn();
    render(<Probe bridge={bridge} onClose={onClose} />);
    await push(evaluateGate(FACTS));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('DeviceDots', () => {
  it('is grey for off, amber for doorbell only and green for live, with words', () => {
    const { getByTestId, rerender } = render(<DeviceDots gate={evaluateGate({ ...FACTS, occupied: false }, true)} />);
    expect(getByTestId('mic-dot')).toHaveAttribute('data-level', 'doorbell');
    expect(getByTestId('mic-dot')).toHaveAttribute('title', 'Microphone doorbell only');
    rerender(<DeviceDots gate={evaluateGate(FACTS)} />);
    expect(getByTestId('mic-dot')).toHaveAttribute('aria-label', 'Microphone live');
    rerender(<DeviceDots gate={evaluateGate({ ...FACTS, cameraEnabled: true })} />);
    expect(getByTestId('camera-dot')).toHaveAttribute('data-level', 'live');
    expect(getByTestId('camera-dot')).toHaveAttribute('aria-label', 'Camera live');
    rerender(<DeviceDots gate={null} />);
    expect(getByTestId('mic-dot')).toHaveAttribute('data-level', 'off');
    expect(getByTestId('camera-dot')).toHaveAttribute('aria-label', 'Camera off');
  });
});
