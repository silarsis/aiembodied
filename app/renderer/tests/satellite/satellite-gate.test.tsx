import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SatelliteBridge, SatelliteStatus } from '../../../main/src/satellite/bridge-types.js';
import { SatelliteGate } from '../../src/satellite/satellite-gate.js';
import { useSatellite } from '../../src/satellite/satellite-context.js';

function status(overrides: Partial<SatelliteStatus> = {}): SatelliteStatus {
  return {
    role: 'satellite',
    paired: false,
    hubUrl: null,
    deviceName: null,
    placeId: null,
    placeName: null,
    link: 'offline',
    linkCode: null,
    lastError: null,
    hostname: 'study-pc',
    ...overrides,
  };
}

function setup(role: 'satellite' | undefined, first: SatelliteStatus) {
  let push: (next: SatelliteStatus) => void = () => undefined;
  const bridge: SatelliteBridge = {
    status: vi.fn().mockResolvedValue(first),
    onStatus: vi.fn((listener: (next: SatelliteStatus) => void) => {
      push = listener;
      return () => undefined;
    }),
    pair: vi.fn().mockResolvedValue(first),
    forget: vi.fn().mockResolvedValue(status()),
  };
  (window as unknown as { aiembodied: unknown }).aiembodied = {
    config: { get: vi.fn().mockResolvedValue({ role }) },
    satellite: bridge,
  };
  return { bridge, push: (next: SatelliteStatus) => act(() => push(next)) };
}

function Probe() {
  const satellite = useSatellite();
  return <p>app on {satellite?.status.placeName}</p>;
}

describe('SatelliteGate', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    delete (window as unknown as { aiembodied?: unknown }).aiembodied;
  });

  it('shows the app untouched on the full app', async () => {
    setup(undefined, status());
    render(
      <SatelliteGate>
        <p>the app</p>
      </SatelliteGate>,
    );
    expect(await screen.findByText('the app')).toBeInTheDocument();
  });

  it('shows the Connect to bija screen when unpaired and sends the form to pair()', async () => {
    const { bridge } = setup('satellite', status());
    render(
      <SatelliteGate>
        <p>the app</p>
      </SatelliteGate>,
    );
    expect(await screen.findByRole('heading', { name: 'Connect to bija' })).toBeInTheDocument();
    expect(screen.queryByText('the app')).toBeNull();
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '12a3456' } });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);
    await waitFor(() =>
      expect(bridge.pair).toHaveBeenCalledWith({ hubUrl: 'ws://bija:8791', code: '123456', placeName: 'the study', deviceName: 'study-pc' }),
    );
  });

  it('shows a refusal from bija under the form', async () => {
    const { bridge } = setup('satellite', status());
    vi.mocked(bridge.pair).mockRejectedValue(new Error("Error invoking remote method 'satellite:pair': Error: That code is not right."));
    render(
      <SatelliteGate>
        <p>the app</p>
      </SatelliteGate>,
    );
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.');
  });

  it('waits for the first connection, then shows the app, and keeps it through a dropped link', async () => {
    const paired = status({ paired: true, hubUrl: 'ws://bija:8791', deviceName: 'study-pc', placeName: 'the study', link: 'connecting' });
    const { push } = setup('satellite', paired);
    render(
      <SatelliteGate>
        <Probe />
      </SatelliteGate>,
    );
    expect(await screen.findByTestId('satellite-waiting')).toBeInTheDocument();
    push({ ...paired, link: 'online' });
    expect(await screen.findByText('app on the study')).toBeInTheDocument();
    push({ ...paired, link: 'offline' });
    expect(screen.getByText('app on the study')).toBeInTheDocument();
  });

  it('takes the app away when the pairing is forgotten', async () => {
    const paired = status({ paired: true, hubUrl: 'ws://bija:8791', deviceName: 'study-pc', placeName: 'the study', link: 'online' });
    const { push } = setup('satellite', paired);
    render(
      <SatelliteGate>
        <Probe />
      </SatelliteGate>,
    );
    expect(await screen.findByText('app on the study')).toBeInTheDocument();
    push(status());
    expect(await screen.findByRole('heading', { name: 'Connect to bija' })).toBeInTheDocument();
  });
});
