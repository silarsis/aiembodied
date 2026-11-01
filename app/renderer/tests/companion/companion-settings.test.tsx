import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompanionSettings } from '../../src/settings/companion-settings.js';
import type { CompanionStatus } from '../../../main/src/companion/types.js';

const status: CompanionStatus = {
  enabled: true,
  port: 8790,
  running: true,
  error: null,
  pairingCode: 'ABCD-EFGH-JKMN',
  urls: ['http://192.168.1.20:8790', 'http://100.64.1.2:8790'],
  devices: [{ id: 'android-1', name: 'Pixel 9', firstSeen: 1, lastSeen: 2, address: '192.168.1.50', connected: true }],
};

describe('CompanionSettings', () => {
  it('shows addresses, the pairing code and phones, and sends a message', async () => {
    const say = vi.fn(async () => ({ delivered: ['android-1'] }));
    const bridge = {
      getStatus: vi.fn(async () => status),
      onStatus: vi.fn(() => () => undefined),
      rotatePairingCode: vi.fn(async () => ({ ...status, pairingCode: 'WXYZ-WXYZ-WXYZ' })),
      forgetDevice: vi.fn(async () => ({ ...status, devices: [] })),
      say,
      setInstructions: vi.fn(async () => undefined),
    };
    const onChange = vi.fn();
    render(<CompanionSettings draft={{ enabled: true, port: 8790 }} onChange={onChange} bridge={bridge} disabled={false} />);

    expect(await screen.findByTestId('companion-code')).toHaveTextContent('ABCD-EFGH-JKMN');
    expect(screen.getByText(/192\.168\.1\.20:8790/)).toBeInTheDocument();
    expect(screen.getByText(/Pixel 9/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Say something on the phone'), { target: { value: 'Dinner!' } });
    fireEvent.click(screen.getByText('Say it'));
    await waitFor(() => expect(say).toHaveBeenCalledWith({ text: 'Dinner!' }));
    expect(await screen.findByText('Said on 1 phone(s).')).toBeInTheDocument();

    fireEvent.click(screen.getByText('New code'));
    await waitFor(() => expect(screen.getByTestId('companion-code')).toHaveTextContent('WXYZ-WXYZ-WXYZ'));

    fireEvent.click(screen.getByLabelText(/Let a phone be the avatar/));
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });
});
