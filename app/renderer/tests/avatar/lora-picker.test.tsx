import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoraPicker } from '../../src/avatar/lora-picker.js';
import type { AvatarBridge, AvatarImageModelSelection } from '../../src/avatar/types.js';

const selection: AvatarImageModelSelection = {
  models: [{ id: 'checkpoints:xl.safetensors', name: 'XL', available: true }],
  selectedModelId: 'checkpoints:xl.safetensors',
  modelFamilies: { 'checkpoints:xl.safetensors': 'sdxl' },
  loras: [
    { name: 'neon.safetensors', title: 'Neon', family: 'sdxl', baseModel: 'SDXL 1.0', triggerWords: ['neon'] },
    { name: 'cyberpunk.safetensors', title: 'Cyberpunk', family: 'sd1', baseModel: 'SD 1.5' },
    { name: 'mystery.safetensors' },
  ],
  selectedLoras: [],
};

describe('LoRA picker', () => {
  it('says when no LoRA fits the chosen model', () => {
    render(
      <LoraPicker
        api={{} as AvatarBridge}
        selection={{ ...selection, loras: [selection.loras![1]] }}
        disabled={false}
        onChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('No LoRAs for this model on this server.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 more for other models' })).toBeTruthy();
  });

  it('turns on a LoRA of the model’s family and sets its strength', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LoraPicker api={{} as AvatarBridge} selection={selection} disabled={false} onChange={onChange} onRefresh={vi.fn()} />);
    expect(screen.getByText('Adds to the prompt: neon')).toBeTruthy();
    // Only LoRAs for the chosen (SDXL) model are listed; the others are behind a link.
    expect(screen.queryByLabelText(/Cyberpunk/)).toBeNull();
    expect(screen.queryByText(/mystery/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '2 more for other models' }));
    expect((screen.getByLabelText(/Cyberpunk/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/base model isn't known/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide LoRAs for other models' }));
    expect(screen.queryByLabelText(/Cyberpunk/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Neon/));
    expect(onChange).toHaveBeenCalledWith([{ name: 'neon.safetensors', strength: 0.8 }]);
    rerender(
      <LoraPicker
        api={{} as AvatarBridge}
        selection={{ ...selection, selectedLoras: [{ name: 'neon.safetensors', strength: 0.8 }] }}
        disabled={false}
        onChange={onChange}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Strength for Neon'), { target: { value: '1.2' } });
    expect(onChange).toHaveBeenLastCalledWith([{ name: 'neon.safetensors', strength: 1.2 }]);
  });

  it('suggests base models for a LoRA with none on the server and downloads one', async () => {
    let downloads = [{ id: 'd1', filename: 'm.safetensors', state: 'downloading' as const, received: 1, total: 2 }];
    const api = {
      suggestBaseModels: vi.fn(async () => ({
        serverId: 'mutiara',
        serverName: 'Mutiara',
        baseModel: 'SD 1.5',
        vramBytes: 8 * 1024 ** 3,
        suggestions: [
          { ref: '1@10', modelId: 1, versionId: 10, name: 'Small · v1', baseModel: 'SD 1.5', sizeKB: 2_000_000, downloads: 5, fits: true },
          { ref: '2@20', modelId: 2, versionId: 20, name: 'Huge · v1', baseModel: 'SD 1.5', sizeKB: 9_000_000, downloads: 4, fits: false },
        ],
      })),
      downloadBaseModel: vi.fn(async () => downloads[0]),
      listModelDownloads: vi.fn(async () => downloads),
    } as unknown as AvatarBridge;
    const onRefresh = vi.fn(async () => undefined);
    render(<LoraPicker api={api} selection={selection} disabled={false} onChange={vi.fn()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: '2 more for other models' }));
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a model' }));
    expect(await screen.findByText(/Popular SD 1.5 models on Civitai, for Mutiara's 8.0 GB GPU/)).toBeTruthy();
    expect(screen.getByText('too big for the GPU')).toBeTruthy();
    expect(api.suggestBaseModels).toHaveBeenCalledWith({ baseModel: 'SD 1.5', family: 'sd1' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Download' })[0]);
    await waitFor(() => expect(api.downloadBaseModel).toHaveBeenCalledWith('mutiara', '1@10'));
    expect(await screen.findByText(/Downloading Small · v1/)).toBeTruthy();
    downloads = [{ ...downloads[0], state: 'done' as never }];
    expect(await screen.findByText('Small · v1 downloaded.', {}, { timeout: 4000 })).toBeTruthy();
    expect(onRefresh).toHaveBeenCalled();
  });
});
