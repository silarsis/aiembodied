import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundControls } from '../../src/backgrounds/background-controls.js';
import { useBackgrounds } from '../../src/backgrounds/use-backgrounds.js';
import type { BackgroundBridge, BackgroundSummary } from '../../../main/src/backgrounds/types.js';

const item = (id: string): BackgroundSummary => ({
  id,
  name: id,
  builtIn: true,
  groundY: 0.86,
  thumbnailDataUrl: 'data:image/png;base64,AA==',
});
function Harness({ api }: { api: BackgroundBridge }) {
  const state = useBackgrounds(api);
  return (
    <>
      <BackgroundControls backgrounds={state} />
      <img alt="Selected scene" src={state.imageUrl ?? undefined} />
    </>
  );
}
function bridge(): BackgroundBridge {
  return {
    list: vi.fn().mockResolvedValue([item('Garden'), item('Beach')]),
    getActive: vi.fn().mockResolvedValue('Garden'),
    setActive: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockImplementation(async (id) => `data:image/png;name=${id};base64,AA==`),
    generate: vi.fn().mockResolvedValue({ ...item('Forest'), builtIn: false }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('background controls', () => {
  it('loads the saved scene and persists user selections including the plain stage', async () => {
    const api = bridge();
    render(<Harness api={api} />);
    expect(await screen.findByRole('button', { name: 'Garden' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(screen.getByAltText('Selected scene')).toHaveAttribute(
        'src',
        expect.stringContaining('Garden'),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Beach' }));
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith('Beach'));
    await waitFor(() =>
      expect(screen.getByAltText('Selected scene')).toHaveAttribute(
        'src',
        expect.stringContaining('Beach'),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Plain background' }));
    await waitFor(() => expect(api.setActive).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.getByAltText('Selected scene')).not.toHaveAttribute('src'));
  });

  it('keeps selection usable during generation and adds the result without replacing the scene', async () => {
    const api = bridge();
    let complete!: (item: BackgroundSummary) => void;
    vi.mocked(api.generate).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    render(<Harness api={api} />);
    await screen.findByRole('button', { name: 'Garden' });
    fireEvent.change(screen.getByLabelText('Background description'), {
      target: { value: 'A forest clearing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate background' }));
    expect(screen.getByRole('button', { name: 'Creating background…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Beach' })).toBeEnabled();
    await act(async () => complete({ ...item('Forest'), builtIn: false }));
    expect(screen.getByRole('button', { name: 'Forest' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Garden' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Delete Forest' })).toBeEnabled();
  });

  it('ignores stale image loads after choosing another scene', async () => {
    const api = bridge();
    let resolveOld!: (image: string) => void;
    vi.mocked(api.load).mockImplementation((id) =>
      id === 'Garden'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve('data:image/png;name=Beach;base64,AA=='),
    );
    render(<Harness api={api} />);
    await waitFor(() => expect(api.load).toHaveBeenCalledWith('Garden'));
    fireEvent.click(screen.getByRole('button', { name: 'Beach' }));
    await waitFor(() =>
      expect(screen.getByAltText('Selected scene')).toHaveAttribute(
        'src',
        expect.stringContaining('Beach'),
      ),
    );
    await act(async () => resolveOld('data:image/png;name=Garden;base64,AA=='));
    expect(screen.getByAltText('Selected scene')).toHaveAttribute(
      'src',
      expect.stringContaining('Beach'),
    );
  });
});
