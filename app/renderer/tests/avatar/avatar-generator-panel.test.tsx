import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AvatarGeneratorPanel } from '../../src/avatar/avatar-generator-panel.js';
import type { AvatarBridge, AvatarGenerationStatus } from '../../src/avatar/types.js';

function createApi(initial: AvatarGenerationStatus | null = null) {
  const state = { current: initial };
  const mocks = {
    generateAvatar: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    getAvatarGenerationStatus: vi.fn(async () => state.current),
    acceptGeneratedAvatar: vi.fn().mockResolvedValue({ vrmId: 'vrm-9' }),
    rejectGeneratedAvatar: vi.fn().mockResolvedValue(undefined),
  };
  return { api: mocks as unknown as AvatarBridge, mocks, state };
}

async function generate(prompt: string) {
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: prompt } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
  });
}

async function poll() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('AvatarGeneratorPanel', () => {
  it('starts a job, shows progress and the concept, and keeps the result', async () => {
    const { api, mocks, state } = createApi({
      jobId: 'job-1',
      status: 'texturing',
      progress: 0.5,
      message: 'Repainting hair (2 of 3)',
      previewDataUrl: 'data:image/png;base64,AAA',
    });
    const onAccepted = vi.fn();
    render(<AvatarGeneratorPanel avatarApi={api} onAccepted={onAccepted} pollIntervalMs={5} />);

    await generate('  Teal hair, white hoodie  ');
    expect(mocks.generateAvatar).toHaveBeenCalledWith({ prompt: 'Teal hair, white hoodie' });

    await poll();
    expect(await screen.findByText(/Repainting hair/)).toBeInTheDocument();
    expect(screen.getByAltText('Generated concept')).toHaveAttribute('src', 'data:image/png;base64,AAA');

    state.current = { ...state.current!, status: 'completed', progress: 1, message: 'Ready to review' };
    await poll();
    const keep = await screen.findByRole('button', { name: 'Keep avatar' });
    await act(async () => {
      fireEvent.click(keep);
    });

    expect(mocks.acceptGeneratedAvatar).toHaveBeenCalledWith('job-1');
    expect(onAccepted).toHaveBeenCalledWith('vrm-9');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows start errors such as ComfyUI being offline', async () => {
    const { api, mocks } = createApi();
    mocks.generateAvatar.mockRejectedValueOnce(new Error("ComfyUI isn't reachable"));
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);

    await generate('A robot');

    expect(await screen.findByRole('alert')).toHaveTextContent("ComfyUI isn't reachable");
  });

  it('cancels a running job', async () => {
    const { api, mocks } = createApi({ jobId: 'job-1', status: 'concept', progress: 0.02, message: 'Drawing a concept image' });
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);

    await generate('A robot');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(mocks.rejectGeneratedAvatar).toHaveBeenCalledWith('job-1');
    expect(screen.getByRole('button', { name: 'Generate' })).not.toBeDisabled();
  });

  it('renders nothing without the generation bridge', () => {
    const { container } = render(<AvatarGeneratorPanel avatarApi={{} as AvatarBridge} />);
    expect(container).toBeEmptyDOMElement();
  });
});
