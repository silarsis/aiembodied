import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VisionStatus } from '../../../main/src/local-vision/vision-model.js';
import type { ModelsBridge } from '../../src/preload-api.js';
import { VisionDownload, visionStatusLine } from '../../src/settings/vision-download.js';

const GB = 1024 ** 3;
const none: VisionStatus = { pick: null, ready: false, sizeBytes: 0, download: null, folder: 'C:/models/vision' };
const download = (state: 'downloading' | 'failed' | 'verifying', extra = {}) => ({
  id: 'd1',
  repo: 'ggml-org/Qwen3-VL-8B-Instruct-GGUF',
  quant: 'q',
  label: 'Q4_K_M + mmproj',
  state,
  received: 2.5 * GB,
  total: 5.8 * GB,
  use: false,
  startedAt: 1,
  ...extra,
});
const ready: VisionStatus = {
  pick: { repo: 'ggml-org/Qwen3-VL-8B-Instruct-GGUF', model: 'C:\\m\\Qwen3-VL-8B-Instruct-Q4_K_M.gguf', mmproj: 'C:\\m\\mmproj-F16.gguf', alias: 'qwen3-vl' },
  ready: true,
  sizeBytes: 5.8 * GB,
  download: null,
  folder: 'C:/models/vision',
};

function bridge(initial: VisionStatus) {
  let status = initial;
  const api = {
    visionStatus: vi.fn(async () => status),
    visionDownload: vi.fn(async (ref?: string) => {
      if (ref === 'qwen words') throw new Error('Paste a Hugging Face link or repo name of a vision model.');
      status = { ...none, download: download('downloading') as never };
      return status;
    }),
    visionCancel: vi.fn(async () => {
      status = none;
      return status;
    }),
  } as unknown as ModelsBridge & Record<string, ReturnType<typeof vi.fn>>;
  return { api, set: (next: VisionStatus) => (status = next) };
}

describe('vision model status line', () => {
  it('says Not downloaded, Downloading with a percent, and Ready with names and size', () => {
    expect(visionStatusLine(none)).toBe('Not downloaded');
    expect(visionStatusLine({ ...none, download: download('downloading') as never })).toBe('Downloading 43%');
    expect(visionStatusLine({ ...none, download: download('failed', { error: 'No space' }) as never })).toBe('Download failed: No space');
    expect(visionStatusLine(ready)).toBe('Ready: Qwen3-VL-8B-Instruct-Q4_K_M.gguf + mmproj-F16.gguf, 5.80 GB');
  });
});

describe('VisionDownload', () => {
  it('shows Not downloaded with the download button, and starts the default download', async () => {
    const { api } = bridge(none);
    render(<VisionDownload api={api} busy={false} />);
    expect(await screen.findByText('Not downloaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download vision model (~6 GB)' }));
    await waitFor(() => expect(api.visionDownload).toHaveBeenCalledWith(undefined));
    expect(await screen.findByText('Downloading 43%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.visionCancel).toHaveBeenCalled());
  });

  it('shows Ready with the file names', async () => {
    const { api } = bridge(ready);
    render(<VisionDownload api={api} busy={false} />);
    expect(await screen.findByText(/Ready: Qwen3-VL-8B-Instruct-Q4_K_M\.gguf \+ mmproj-F16\.gguf/)).toBeTruthy();
  });

  it('downloads another repo from the text field and shows an error from the app', async () => {
    const { api } = bridge(none);
    render(<VisionDownload api={api} busy={false} />);
    await screen.findByText('Not downloaded');
    const field = screen.getByLabelText('Use another model…');
    fireEvent.change(field, { target: { value: 'qwen words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download this one' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Paste a Hugging Face link');
    fireEvent.change(field, { target: { value: 'someone/Qwen3-VL-GGUF:Q4_K_M' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download this one' }));
    await waitFor(() => expect(api.visionDownload).toHaveBeenLastCalledWith('someone/Qwen3-VL-GGUF:Q4_K_M'));
  });
});
