import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GpuMemorySnapshot } from '../../../main/src/diagnostics/gpu-memory.js';
import { buildSegments, GpuMemoryView } from '../../src/status/gpu-memory-bar.js';

const GB = 1024 ** 3;
const snapshot: GpuMemorySnapshot = {
  supported: true,
  adapterName: 'AMD Radeon(TM) 8060S Graphics',
  dedicatedTotal: 96 * GB,
  sharedTotal: 16 * GB,
  used: { dedicated: 95 * GB, shared: 3 * GB },
  servers: [
    { id: 'local-llm', name: 'Language model', port: 1234, pid: 1, processName: 'llama-server', dedicated: 80 * GB, shared: 1 * GB },
    { id: 'local-comfy', name: 'ComfyUI', port: 8188, dedicated: 0, shared: 0 },
  ],
  others: [{ pid: 3, name: 'UnslothStudio', dedicated: 10 * GB, shared: 0 }],
  unattributed: { dedicated: 5 * GB, shared: 2 * GB },
  takenAt: 0,
};

describe('buildSegments', () => {
  it('lists servers in use, then Other with the remainder', () => {
    const { segments, used, total } = buildSegments(snapshot, 'dedicated');
    expect(segments.map((s) => [s.label, s.bytes / GB])).toEqual([
      ['Language model', 80],
      ['Other', 15],
    ]);
    expect(segments[1].title).toContain('UnslothStudio');
    expect(used).toBe(95 * GB);
    expect(total).toBe(96 * GB);
  });
});

describe('GpuMemoryView', () => {
  it('shows both pools and the idle servers', () => {
    render(<GpuMemoryView snapshot={snapshot} />);
    expect(screen.getByTestId('gpu-memory-dedicated').textContent).toContain('95 GB used of 96 GB');
    expect(screen.getByTestId('gpu-memory-shared').textContent).toContain('3.0 GB used of 16 GB');
    expect(screen.getByText(/Not using the GPU or not running: ComfyUI/)).toBeTruthy();
  });

  it('explains when there are no numbers', () => {
    render(<GpuMemoryView snapshot={{ ...snapshot, supported: false, reason: 'Only on Windows.' }} />);
    expect(screen.getByText('Only on Windows.')).toBeTruthy();
  });
});
