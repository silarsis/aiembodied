import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AvatarRenderer } from '../../src/avatar/avatar-renderer.js';

describe('AvatarRenderer', () => {
  it('exposes viseme telemetry via data attributes', async () => {
    const { rerender } = render(<AvatarRenderer frame={null} />);
    const canvas = screen.getByRole('img', { name: /assistant avatar idle/i });

    expect(canvas.dataset.visemeIndex).toBe('0');
    expect(canvas.dataset.visemeIntensity).toBe('0.000');
    expect(canvas.dataset.blink).toBe('false');

    rerender(<AvatarRenderer frame={{ t: 25, index: 3, intensity: 0.72 }} />);

    await waitFor(() => {
      expect(canvas.dataset.visemeIndex).toBe('3');
      expect(canvas.dataset.visemeIntensity).toBe('0.720');
      expect(canvas.dataset.blink).toBe('false');
    });

    rerender(<AvatarRenderer frame={{ t: 60, index: 1, intensity: 0.42, blink: true }} />);

    await waitFor(() => {
      expect(canvas.dataset.visemeIndex).toBe('1');
      expect(canvas.dataset.visemeIntensity).toBe('0.420');
      expect(canvas.dataset.blink).toBe('true');
    });
  });

  it('updates aria label based on the active frame', async () => {
    const { rerender } = render(<AvatarRenderer frame={null} />);
    const canvas = screen.getByRole('img', { name: /assistant avatar idle/i });

    expect(canvas.getAttribute('aria-label')).toBe('Assistant avatar idle');

    rerender(<AvatarRenderer frame={{ t: 10, index: 4, intensity: 0.86, blink: true }} />);

    await waitFor(() => {
      expect(canvas.getAttribute('aria-label')).toBe(
        'Assistant avatar speaking with viseme 4 at 86% intensity, blink triggered',
      );
    });
  });
});
