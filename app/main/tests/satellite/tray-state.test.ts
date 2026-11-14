import { describe, expect, it } from 'vitest';
import { stateIcon, toBgra, trayRoomName, trayTooltip } from '../../src/satellite/tray-state.js';

describe('tray state', () => {
  it('names the room without "the" and with a capital', () => {
    expect(trayRoomName('the study')).toBe('Study');
    expect(trayRoomName('The Loft')).toBe('Loft');
    expect(trayRoomName(null)).toBe('This room');
    expect(trayRoomName('  ')).toBe('This room');
  });

  it('says mic live, doorbell only or off', () => {
    expect(trayTooltip('the study', { mic: 'live' })).toBe('Study: mic live');
    expect(trayTooltip('the study', { mic: 'doorbell' })).toBe('Study: doorbell only');
    expect(trayTooltip('the study', { mic: 'off' })).toBe('Study: off');
  });

  it('draws a green, amber or grey dot', () => {
    const dot = (level: 'live' | 'doorbell' | 'off') => {
      const icon = stateIcon(level, 32);
      // Centre of the dot: 0.68 of the way across and down.
      const at = (Math.round(32 * 0.68) * 32 + Math.round(32 * 0.68)) * 4;
      return [...icon.data.subarray(at, at + 4)];
    };
    expect(dot('live')).toEqual([34, 197, 94, 255]);
    expect(dot('doorbell')).toEqual([245, 158, 11, 255]);
    expect(dot('off')).toEqual([148, 163, 184, 255]);
    const icon = stateIcon('live', 32);
    expect(icon.data.length).toBe(32 * 32 * 4);
    // The corners are transparent.
    expect(icon.data[3]).toBe(0);
  });

  it('swaps red and blue for Electron', () => {
    expect([...toBgra(Buffer.from([1, 2, 3, 4]))]).toEqual([3, 2, 1, 4]);
  });
});
