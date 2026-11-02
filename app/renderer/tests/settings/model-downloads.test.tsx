import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelDownload } from '../../../main/src/avatar/generation/model-downloads.js';
import type { ModelServerView } from '../../../main/src/config/config-manager.js';
import type { ModelsBridge } from '../../src/preload-api.js';
import { ModelDownloads, formatBytes } from '../../src/settings/model-downloads.js';

const rack: ModelServerView = { id: 'rack', name: 'Mutiara', type: 'comfy', url: 'http://mutiara:8188', builtIn: false, managed: false, hasKey: false };

const lookup = {
  versions: [
    { id: 900, name: 'v2', baseModel: 'Pony' },
    { id: 800, name: 'v1', baseModel: 'SD 1.5' },
  ],
  plan: {
    modelId: 4201,
    versionId: 900,
    title: 'Pony Realism · v2',
    type: 'Checkpoint',
    baseModel: 'Pony',
    folder: 'checkpoints',
    kind: 'sdxl',
    file: { name: 'pony.safetensors', sizeKB: 6_000_000, downloadUrl: 'https://civitai.com/x', primary: true },
  },
};

function download(state: ModelDownload['state'], received: number): ModelDownload {
  return { id: 'd1', serverId: 'rack', serverName: 'Mutiara', title: 'Pony', folder: 'checkpoints', filename: 'pony.safetensors', state, received, total: 100, startedAt: 1 };
}

function bridge(installed: boolean) {
  let list: ModelDownload[] = [];
  return {
    api: {
      civitaiLookup: vi.fn(async () => lookup),
      download: vi.fn(async () => {
        list = [download('downloading', 40)];
        return list[0];
      }),
      downloads: vi.fn(async () => list),
      cancelDownload: vi.fn(async () => list),
      comfyAddon: vi.fn(async () => ({ installed, folder: 'C:/app/comfyui-aiembodied' })),
    } as unknown as ModelsBridge & Record<string, ReturnType<typeof vi.fn>>,
    finish: () => {
      list = [download('done', 100)];
    },
  };
}

describe('Download a model', () => {
  it('looks up a Civitai link, downloads it to the server, and refreshes the list when done', async () => {
    const { api, finish } = bridge(true);
    const onFinished = vi.fn();
    render(<ModelDownloads api={api} server={rack} onFinished={onFinished} />);
    fireEvent.change(screen.getByLabelText('Civitai link'), { target: { value: 'https://civitai.com/models/4201' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('Pony Realism · v2')).toBeTruthy();
    expect(screen.getByText(/Checkpoint · Pony · pony.safetensors · 5.72 GB → checkpoints/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Download to Mutiara' }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith('rack', 'https://civitai.com/models/4201', 900));
    expect(await screen.findByRole('progressbar', { name: 'Downloading pony.safetensors' })).toBeTruthy();
    finish();
    expect(await screen.findByText('Downloaded.', {}, { timeout: 4000 })).toBeTruthy();
    expect(onFinished).toHaveBeenCalled();
  });

  it('shows where the add-on is when the server has none', async () => {
    const { api } = bridge(false);
    render(<ModelDownloads api={api} server={rack} onFinished={vi.fn()} />);
    expect(await screen.findByText(/needs the aiembodied add-on/)).toBeTruthy();
    expect(screen.getByText('C:/app/comfyui-aiembodied')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(api.comfyAddon).toHaveBeenCalledTimes(2));
  });

  it('formats sizes', () => {
    expect(formatBytes(5 * 1024 ** 2)).toBe('5 MB');
    expect(formatBytes(6.5 * 1024 ** 3)).toBe('6.50 GB');
  });
});
