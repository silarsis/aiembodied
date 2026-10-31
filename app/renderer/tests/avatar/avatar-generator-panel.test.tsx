import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AvatarGeneratorPanel } from '../../src/avatar/avatar-generator-panel.js';
import type { AvatarBridge, AvatarGenerationStatus } from '../../src/avatar/types.js';
import { generatePoseSnapshot } from '../../src/avatar/pose-snapshot-generator.js';
import { readAvatarReference } from '../../src/avatar/reference-image-upload.js';

vi.mock('../../src/avatar/reference-image-upload.js', () => ({
  readAvatarReference: vi.fn().mockResolvedValue({ mimeType: 'image/png', data: 'UPLOADED' }),
}));

vi.mock('../../src/avatar/pose-snapshot-generator.js', () => ({
  generatePoseSnapshot: vi
    .fn()
    .mockResolvedValue({ dataUrl: 'data:image/png;base64,FINISHED', width: 512, height: 768 }),
}));

function createApi(initial: AvatarGenerationStatus | null = null) {
  const state = { current: initial };
  const mocks = {
    generateAvatar: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    getAvatarGenerationStatus: vi.fn(async () => state.current),
    confirmAvatarConcept: vi.fn().mockResolvedValue(undefined),
    loadGeneratedAvatarPreview: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    acceptGeneratedAvatar: vi.fn().mockResolvedValue({ vrmId: 'vrm-9' }),
    rejectGeneratedAvatar: vi.fn().mockResolvedValue(undefined),
  };
  return { api: mocks as unknown as AvatarBridge, mocks, state };
}

async function generate(prompt: string) {
  fireEvent.change(screen.getByLabelText('Avatar description'), { target: { value: prompt } });
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
  it('shows detected models, saves a choice and sends just that model ID with the prompt', async () => {
    const { api, mocks } = createApi();
    const setAvatarImageModel = vi.fn().mockResolvedValue(undefined);
    Object.assign(mocks, {
      setAvatarImageModel,
      listAvatarImageModels: vi.fn().mockResolvedValue({
        selectedModelId: 'qwen',
        models: [
          { id: 'qwen', name: 'Qwen-Image 2.1', available: true },
          { id: 'z', name: 'Z-Image Turbo', available: true },
          { id: 'missing', name: 'Incomplete model', available: false },
        ],
      }),
    });
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);
    expect(await screen.findByRole('option', { name: 'Z-Image Turbo' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Incomplete model (unavailable)' })).toBeDisabled();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Image model'), { target: { value: 'z' } });
    });
    expect(setAvatarImageModel).toHaveBeenCalledWith('z');
    await generate('An explorer');
    expect(mocks.generateAvatar).toHaveBeenCalledWith({
      prompt: 'An explorer',
      mode: 'new-character',
      imageModelId: 'z',
    });
  });
  it('discards the reviewed concept before regenerating from an edited prompt', async () => {
    const { api, mocks, state } = createApi({
      jobId: 'job-1',
      status: 'awaiting_confirmation',
      progress: 0.15,
      previewDataUrl: 'data:image/png;base64,OLD',
    });
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);
    await generate('An explorer');
    await poll();
    const prompt = screen.getByLabelText('Avatar description');
    expect(prompt).toBeEnabled();
    fireEvent.change(prompt, { target: { value: 'An explorer with blue hair' } });
    let finishDiscard!: () => void;
    mocks.rejectGeneratedAvatar.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDiscard = resolve;
        }),
    );
    let finishGeneration!: (job: { jobId: string }) => void;
    mocks.generateAvatar.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishGeneration = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate image' }));
    expect(mocks.rejectGeneratedAvatar).toHaveBeenCalledWith('job-1');
    expect(mocks.generateAvatar).toHaveBeenCalledTimes(1);
    expect(prompt).toBeDisabled();
    state.current = {
      jobId: 'job-2',
      status: 'awaiting_confirmation',
      progress: 0.15,
      previewDataUrl: 'data:image/png;base64,NEW',
    };
    await act(async () => {
      finishDiscard();
    });
    expect(mocks.generateAvatar).toHaveBeenLastCalledWith({
      prompt: 'An explorer with blue hair',
      mode: 'new-character',
    });
    expect(screen.queryByAltText('Generated concept')).not.toBeInTheDocument();
    await act(async () => {
      finishGeneration({ jobId: 'job-2' });
    });
    await poll();
    expect(await screen.findByAltText('Generated concept')).toHaveAttribute(
      'src',
      'data:image/png;base64,NEW',
    );
    expect(screen.getByRole('button', { name: 'Regenerate image' })).toBeEnabled();
    expect(mocks.confirmAvatarConcept).not.toHaveBeenCalled();
  });

  it('keeps the revised prompt editable if replacement generation fails after discarding', async () => {
    const { api, mocks } = createApi({
      jobId: 'job-1',
      status: 'awaiting_confirmation',
      progress: 0.15,
      previewDataUrl: 'data:image/png;base64,OLD',
    });
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);
    await generate('An explorer');
    await poll();
    fireEvent.change(screen.getByLabelText('Avatar description'), {
      target: { value: 'A blue-haired explorer' },
    });
    mocks.generateAvatar.mockRejectedValueOnce(new Error('Generation unavailable'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate image' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Generation unavailable');
    expect(screen.getByLabelText('Avatar description')).toHaveValue('A blue-haired explorer');
    expect(screen.getByLabelText('Avatar description')).toBeEnabled();
    expect(screen.queryByAltText('Generated concept')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });
  it('uploads an image without requiring a text description and still waits for approval', async () => {
    const { api, mocks } = createApi({
      jobId: 'job-1',
      status: 'awaiting_confirmation',
      progress: 0.15,
      previewDataUrl: 'data:image/png;base64,UPLOADED',
    });
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Upload an image' }));
    const file = new File(['image'], 'character.jpg', { type: 'image/jpeg' });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Character reference image'), {
        target: { files: [file] },
      });
    });
    expect(readAvatarReference).toHaveBeenCalledWith(file);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review uploaded image' }));
    });
    await poll();
    expect(mocks.generateAvatar).toHaveBeenCalledWith({
      prompt: '',
      mode: 'new-character',
      referenceImage: { mimeType: 'image/png', data: 'UPLOADED' },
    });
    expect(
      await screen.findByRole('button', { name: 'Enlarge uploaded reference' }),
    ).toBeInTheDocument();
    expect(mocks.confirmAvatarConcept).not.toHaveBeenCalled();
  });
  it('waits for explicit concept approval before continuing and polls the resumed job', async () => {
    const { api, mocks, state } = createApi({
      jobId: 'job-1',
      status: 'awaiting_confirmation',
      progress: 0.15,
      previewDataUrl: 'data:image/png;base64,CONCEPT',
    });
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);
    await generate('An explorer');
    await poll();
    expect(await screen.findByText(/Generation is paused until you confirm/)).toBeInTheDocument();
    expect(mocks.confirmAvatarConcept).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Keep avatar' })).not.toBeInTheDocument();
    state.current = {
      ...state.current!,
      status: 'meshing',
      progress: 0.2,
      message: 'Generating geometry',
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use this image — create 3D avatar' }));
    });
    expect(mocks.confirmAvatarConcept).toHaveBeenCalledWith('job-1');
    expect(await screen.findByText('Generating geometry')).toBeInTheDocument();
  });
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
    expect(mocks.generateAvatar).toHaveBeenCalledWith({
      prompt: 'Teal hair, white hoodie',
      mode: 'new-character',
    });

    await poll();
    expect(await screen.findByText(/Repainting hair/)).toBeInTheDocument();
    expect(screen.getByAltText('Generated concept')).toHaveAttribute(
      'src',
      'data:image/png;base64,AAA',
    );

    state.current = {
      ...state.current!,
      status: 'completed',
      progress: 1,
      message: 'Ready to review',
    };
    await poll();
    const keep = await screen.findByRole('button', { name: 'Keep avatar' });
    expect(await screen.findByAltText('Finished avatar model')).toHaveAttribute(
      'src',
      'data:image/png;base64,FINISHED',
    );
    expect(mocks.loadGeneratedAvatarPreview).toHaveBeenCalledWith('job-1');
    await act(async () => {
      fireEvent.click(keep);
    });

    expect(mocks.acceptGeneratedAvatar).toHaveBeenCalledWith('job-1');
    expect(onAccepted).toHaveBeenCalledWith('vrm-9');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('cannot accept the concept as a finished model when preview rendering fails, and can retry', async () => {
    vi.mocked(generatePoseSnapshot).mockRejectedValueOnce(new Error('Preview failed'));
    const { api, mocks } = createApi({
      jobId: 'job-1',
      status: 'completed',
      progress: 1,
      previewDataUrl: 'data:image/png;base64,CONCEPT',
    });
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);
    expect(screen.getByText(/generate a new stylised 3D humanoid/)).toBeInTheDocument();
    await generate('Teal hair');
    await poll();
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview failed');
    expect(screen.getByRole('button', { name: 'Keep avatar' })).toBeDisabled();
    expect(mocks.acceptGeneratedAvatar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    expect(await screen.findByAltText('Finished avatar model')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep avatar' })).toBeEnabled();
  });

  it('shows start errors such as ComfyUI being offline', async () => {
    const { api, mocks } = createApi();
    mocks.generateAvatar.mockRejectedValueOnce(new Error("ComfyUI isn't reachable"));
    render(<AvatarGeneratorPanel avatarApi={api} pollIntervalMs={5} />);

    await generate('A robot');

    expect(await screen.findByRole('alert')).toHaveTextContent("ComfyUI isn't reachable");
  });

  it('cancels a running job', async () => {
    const { api, mocks } = createApi({
      jobId: 'job-1',
      status: 'concept',
      progress: 0.02,
      message: 'Drawing a concept image',
    });
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
