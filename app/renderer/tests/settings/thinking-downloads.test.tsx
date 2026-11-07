import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HfLookup } from '../../../main/src/local-llm/huggingface.js';
import type { LlmDownload, LocalLlmList } from '../../../main/src/local-llm/llm-library.js';
import type { ModelsBridge } from '../../src/preload-api.js';
import { ThinkingDownloads } from '../../src/settings/thinking-downloads.js';

const GB = 1024 ** 3;
const lookup: HfLookup = {
  repo: 'unsloth/Qwen3-8B-GGUF',
  gated: false,
  quants: [
    { id: 'Qwen3-8B-Q2_K.gguf', label: 'Q2_K', sizeBytes: 3 * GB, files: [{ path: 'Qwen3-8B-Q2_K.gguf', size: 3 * GB }] },
    { id: 'Qwen3-8B-Q4_K_M.gguf', label: 'Q4_K_M', sizeBytes: 5 * GB, files: [{ path: 'Qwen3-8B-Q4_K_M.gguf', size: 5 * GB }] },
    { id: 'BF16/Qwen3-8B-BF16.gguf', label: 'BF16', sizeBytes: 16 * GB, files: [{ path: 'a', size: 8 * GB }, { path: 'b', size: 8 * GB }] },
  ],
  selected: 'Qwen3-8B-Q4_K_M.gguf',
  contextLength: 40960,
  suggestions: [],
};

function bridge() {
  let list: LlmDownload[] = [];
  let library: LocalLlmList = { models: [], folder: 'C:/Users/kevin/.cache/aiembodied/llm-models' };
  const entry = (state: LlmDownload['state'], extra: Partial<LlmDownload> = {}): LlmDownload => ({
    id: 'd1',
    repo: 'unsloth/Qwen3-8B-GGUF',
    quant: 'BF16/Qwen3-8B-BF16.gguf',
    label: 'BF16',
    state,
    received: 4 * GB,
    total: 16 * GB,
    use: true,
    startedAt: 1,
    ...extra,
  });
  const api = {
    get: vi.fn(async () => ({ servers: [], routes: {} })),
    hfLookup: vi.fn(async (ref: string) =>
      ref === 'qwen3 8b' ? { gated: false, quants: [], suggestions: [{ repo: 'unsloth/Qwen3-8B-GGUF', downloads: 1234, likes: 1 }] } : lookup,
    ),
    hfDownload: vi.fn(async () => {
      list = [entry('downloading')];
      return list[0];
    }),
    hfDownloads: vi.fn(async () => list),
    hfCancel: vi.fn(async () => list),
    localLlms: vi.fn(async () => library),
    useLocalLlm: vi.fn(async () => ({ message: 'llama-server is restarting with its default model.', library, models: { servers: [], routes: {} } })),
    deleteLocalLlm: vi.fn(async () => library),
  } as unknown as ModelsBridge & Record<string, ReturnType<typeof vi.fn>>;
  return {
    api,
    finish: () => {
      list = [entry('done', { received: 16 * GB, result: 'llama-server is restarting with qwen3-8b-bf16.' })];
      library = {
        ...library,
        selected: 'unsloth/Qwen3-8B-GGUF:BF16/Qwen3-8B-BF16.gguf',
        models: [
          {
            id: 'unsloth/Qwen3-8B-GGUF:BF16/Qwen3-8B-BF16.gguf',
            repo: 'unsloth/Qwen3-8B-GGUF',
            quant: 'BF16/Qwen3-8B-BF16.gguf',
            alias: 'qwen3-8b-bf16',
            path: 'C:/m/a',
            files: ['C:/m/a', 'C:/m/b'],
            sizeBytes: 16 * GB,
            downloadedAt: 2,
          },
        ],
      };
    },
  };
}

describe('Download a thinking model', () => {
  it('looks a repo up, offers its sizes, downloads the picked one and switches Thinking to it', async () => {
    const { api, finish } = bridge();
    const onView = vi.fn();
    render(<ThinkingDownloads api={api} busy={false} onView={onView} />);
    fireEvent.change(screen.getByLabelText('Hugging Face model'), { target: { value: 'https://huggingface.co/unsloth/Qwen3-8B-GGUF' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('unsloth/Qwen3-8B-GGUF')).toBeTruthy();
    const size = screen.getByLabelText(/Size/) as HTMLSelectElement;
    expect(size.value).toBe('Qwen3-8B-Q4_K_M.gguf');
    expect([...size.options].map((option) => option.textContent)).toEqual(['Q2_K · 3.00 GB', 'Q4_K_M · 5.00 GB', 'BF16 · 16.00 GB (2 parts)']);
    expect(screen.getByText(/Made for up to 40,960 tokens/)).toBeTruthy();

    fireEvent.change(size, { target: { value: 'BF16/Qwen3-8B-BF16.gguf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download 16.00 GB' }));
    await waitFor(() => expect(api.hfDownload).toHaveBeenCalledWith('unsloth/Qwen3-8B-GGUF', 'BF16/Qwen3-8B-BF16.gguf', true));
    expect(await screen.findByLabelText('Downloading unsloth/Qwen3-8B-GGUF BF16')).toBeTruthy();

    finish();
    expect(await screen.findByText('llama-server is restarting with qwen3-8b-bf16.', {}, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(onView).toHaveBeenCalled());
    expect(screen.getByText('In use')).toBeTruthy();
  });

  it('offers GGUF repos for search words', async () => {
    const { api } = bridge();
    render(<ThinkingDownloads api={api} busy={false} onView={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Hugging Face model'), { target: { value: 'qwen3 8b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    fireEvent.click(await screen.findByRole('button', { name: /unsloth\/Qwen3-8B-GGUF/ }));
    await waitFor(() => expect(api.hfLookup).toHaveBeenLastCalledWith('unsloth/Qwen3-8B-GGUF'));
    expect(await screen.findByLabelText(/Size/)).toBeTruthy();
  });

  it('goes back to the start script default', async () => {
    const { api, finish } = bridge();
    finish();
    render(<ThinkingDownloads api={api} busy={false} onView={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    await waitFor(() => expect(api.useLocalLlm).toHaveBeenCalledWith(null));
    expect(await screen.findByText('llama-server is restarting with its default model.')).toBeTruthy();
  });
});
