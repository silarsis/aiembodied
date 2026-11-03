import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarStudio, AvatarStudioLauncher } from '../../src/avatar/avatar-studio.js';
import type { AvatarBridge, AvatarGenerationStatus } from '../../src/avatar/types.js';
import { createModelReviewScene } from '../../src/avatar/model-review-scene.js';

vi.mock('../../src/avatar/model-review-scene.js', () => ({ createModelReviewScene: vi.fn() }));
vi.mock('../../src/avatar/reference-image-upload.js', () => ({
  readAvatarReference: vi.fn().mockResolvedValue({ mimeType: 'image/png', data: 'UPLOADED' }),
}));

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.open = false;
    },
  });
});
afterAll(() => {
  for (const [name, descriptor] of [
    ['showModal', originalShow],
    ['close', originalClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

const scene = {
  view: vi.fn(),
  expression: vi.fn(),
  pose: vi.fn(),
  expressions: ['happy'],
  dispose: vi.fn(),
};

function take(id: string, patch: Partial<AvatarGenerationStatus> = {}): AvatarGenerationStatus {
  return {
    jobId: id,
    status: 'awaiting_confirmation',
    progress: 0.15,
    previewDataUrl: `data:image/png;base64,${id}`,
    prompt: `Prompt for ${id}`,
    mode: 'new-character',
    source: 'text',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    imageModelName: 'Qwen-Image 2.1',
    ...patch,
  };
}

function createApi(initial: AvatarGenerationStatus[] = []) {
  const jobs = { current: initial };
  let next = initial.length + 1;
  const mocks = {
    listAvatarGenerationJobs: vi.fn(async () => jobs.current),
    generateAvatar: vi.fn(async (request: { prompt?: string }) => {
      const id = `job-${next++}`;
      jobs.current = [...jobs.current, take(id, { prompt: request.prompt })];
      return { jobId: id };
    }),
    getAvatarGenerationStatus: vi.fn(),
    confirmAvatarConcept: vi.fn(async (id: string) => {
      jobs.current = jobs.current.map((job) =>
        job.jobId === id
          ? { ...job, status: 'meshing', progress: 0.3, message: 'Generating geometry' }
          : job,
      );
    }),
    cancelAvatarGeneration: vi.fn(async (id: string) => {
      jobs.current = jobs.current.map((job) =>
        job.jobId === id ? { ...job, status: 'cancelled' } : job,
      );
    }),
    loadGeneratedAvatarPreview: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    acceptGeneratedAvatar: vi.fn(async (id: string) => {
      jobs.current = jobs.current.filter((job) => job.jobId !== id);
      return { vrmId: 'vrm-9' };
    }),
    rejectGeneratedAvatar: vi.fn(async (id: string) => {
      jobs.current = jobs.current.filter((job) => job.jobId !== id);
    }),
    listAvatarImageModels: vi.fn().mockResolvedValue({
      selectedModelId: 'qwen',
      models: [{ id: 'qwen', name: 'Qwen-Image 2.1', available: true }],
    }),
    setAvatarImageModel: vi.fn().mockResolvedValue(undefined),
    listAvatarCharacterModels: vi.fn().mockResolvedValue({
      geometry: [
        {
          id: 'int8',
          name: 'TRELLIS.2 (int8 convrot)',
          available: true,
          description: 'Textured mesh.',
        },
        { id: 'bf16', name: 'TRELLIS.2 (bf16)', available: true },
      ],
      rig: [{ id: 'blender-face-fit', name: 'Blender auto-rig with fitted face', available: true }],
      selectedGeometryId: 'int8',
      selectedRigId: 'blender-face-fit',
    }),
    setAvatarCharacterModel: vi.fn().mockResolvedValue(undefined),
    listPoses: vi
      .fn()
      .mockResolvedValue([
        { id: 'builtin:happiness', name: 'Happiness', builtIn: true, createdAt: 0, fileSha: 'a' },
      ]),
    loadPose: vi.fn().mockResolvedValue({ bones: {} }),
  };
  return { api: mocks as unknown as AvatarBridge, mocks, jobs };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createModelReviewScene).mockResolvedValue(scene);
});

describe('avatar studio', () => {
  it('opens from the sidebar button only when the bridge supports takes', async () => {
    const { api } = createApi();
    const { rerender } = render(<AvatarStudioLauncher avatarApi={{} as AvatarBridge} />);
    expect(screen.queryByRole('button', { name: 'Open avatar studio' })).not.toBeInTheDocument();
    rerender(<AvatarStudioLauncher avatarApi={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open avatar studio' }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'Avatar studio' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close avatar studio' }));
    expect(screen.queryByRole('dialog', { name: 'Avatar studio' })).not.toBeInTheDocument();
  });

  it('generates with the chosen image model and keeps earlier takes when regenerating', async () => {
    const { api, mocks } = createApi();
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    fireEvent.change(screen.getByLabelText('Avatar description'), {
      target: { value: 'An explorer' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    });
    expect(mocks.generateAvatar).toHaveBeenCalledWith({
      prompt: 'An explorer',
      mode: 'new-character',
      imageModelId: 'qwen',
    });
    expect(screen.getByRole('heading', { name: 'Image · take 1' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Take 1 concept' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    });
    expect(mocks.rejectGeneratedAvatar).not.toHaveBeenCalled();
    const history = screen.getByLabelText('Takes');
    expect(within(history).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Image · take 2' })).toBeInTheDocument();
    fireEvent.click(within(history).getByRole('button', { name: 'Take 1' }));
    expect(screen.getByRole('heading', { name: 'Image · take 1' })).toBeInTheDocument();
  });

  it('lets any model draw the front for a multi-view 3D model, with Qwen-Image drawing the views', async () => {
    const { api, mocks } = createApi();
    const hunyuan = {
      geometry: [
        { id: 'hy', name: 'Hunyuan3D 2mv', available: true, views: true },
        { id: 'int8', name: 'TRELLIS.2 (int8 convrot)', available: true },
      ],
      rig: [{ id: 'blender-face-fit', name: 'Blender auto-rig with fitted face', available: true }],
      selectedGeometryId: 'hy',
      selectedRigId: 'blender-face-fit',
    };
    mocks.listAvatarCharacterModels.mockResolvedValue(hunyuan);
    mocks.listAvatarImageModels.mockResolvedValue({
      selectedModelId: 'xl',
      models: [
        { id: 'qwen', name: 'Qwen-Image 2.1', available: true },
        { id: 'xl', name: 'Custom XL', available: true },
      ],
      modelFamilies: { qwen: 'qwen-image-2.1', xl: 'sdxl' },
    });
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    await settle();
    expect(mocks.setAvatarImageModel).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'Custom XL' })).toBeEnabled();
    expect(screen.getByText(/Qwen-Image 2.1 then draws the side and back/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Avatar description'), { target: { value: 'An explorer' } });
    expect(screen.getByRole('button', { name: 'Generate image' })).toBeEnabled();
  });

  it('blocks generating for a multi-view 3D model when no Qwen-Image is installed', async () => {
    const { api, mocks } = createApi();
    mocks.listAvatarCharacterModels.mockResolvedValue({
      geometry: [{ id: 'hy', name: 'Hunyuan3D 2mv', available: true, views: true }],
      rig: [{ id: 'blender-face-fit', name: 'Blender auto-rig with fitted face', available: true }],
      selectedGeometryId: 'hy',
      selectedRigId: 'blender-face-fit',
    });
    mocks.listAvatarImageModels.mockResolvedValue({
      selectedModelId: 'xl',
      models: [{ id: 'xl', name: 'Custom XL', available: true }],
      modelFamilies: { xl: 'sdxl' },
    });
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    fireEvent.change(screen.getByLabelText('Avatar description'), { target: { value: 'An explorer' } });
    expect(screen.getByText(/needs Qwen-Image 2.1 on the image server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate image' })).toBeDisabled();
  });

  it('offers the 3D model selector on the image step, hides a rig choice of one, and builds with them', async () => {
    const { api, mocks } = createApi([take('job-1')]);
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    expect(screen.getByRole('option', { name: 'TRELLIS.2 (bf16)' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Rig and animation')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('3D model'), { target: { value: 'bf16' } });
    });
    expect(mocks.setAvatarCharacterModel).toHaveBeenCalledWith('geometry', 'bf16');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use this image and build 3D' }));
    });
    expect(mocks.confirmAvatarConcept).toHaveBeenCalledWith('job-1', {
      geometryModelId: 'bf16',
      rigModelId: 'blender-face-fit',
    });
    expect(screen.getByRole('heading', { name: '3D avatar · take 1' })).toBeInTheDocument();
    expect(screen.getAllByText('Generating 3D geometry').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel build' }));
    });
    expect(mocks.cancelAvatarGeneration).toHaveBeenCalledWith('job-1');
  });

  it('removes the background only when asked, and can restore the original', async () => {
    const { api, mocks, jobs } = createApi([take('job-1')]);
    const extra = mocks as unknown as Record<string, unknown>;
    extra.removeAvatarBackground = vi.fn(async (id: string) => {
      jobs.current = jobs.current.map((job) =>
        job.jobId === id ? { ...job, backgroundRemoved: true, previewDataUrl: 'data:image/png;base64,CUT' } : job,
      );
    });
    extra.restoreAvatarBackground = vi.fn(async (id: string) => {
      jobs.current = jobs.current.map((job) => (job.jobId === id ? { ...job, backgroundRemoved: false } : job));
    });
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    expect(extra.removeAvatarBackground).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove background' }));
    });
    expect(extra.removeAvatarBackground).toHaveBeenCalledWith('job-1');
    expect(screen.getByText('The character was cut out onto plain white.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore original image' }));
    });
    expect(extra.restoreAvatarBackground).toHaveBeenCalledWith('job-1');
    expect(screen.getByRole('button', { name: 'Remove background' })).toBeInTheDocument();
  });

  it('shows the side and back views beside the front, and redraws them on request', async () => {
    const { api, mocks } = createApi([
      take('job-1', { views: { left: 'data:image/png;base64,SIDE', back: 'data:image/png;base64,BACK' } }),
    ]);
    const extra = mocks as unknown as Record<string, unknown>;
    extra.redrawAvatarViews = vi.fn(async () => undefined);
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    expect(screen.getByRole('img', { name: 'Take 1 side view' })).toHaveAttribute('src', 'data:image/png;base64,SIDE');
    expect(screen.getByRole('img', { name: 'Take 1 back view' })).toBeInTheDocument();

    // The enlarged image steps through front, side and back with arrows (buttons and keys).
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge take 1 side view' }));
    const full = () => screen.getByRole('img', { name: /full size$/ });
    expect(full()).toHaveAttribute('src', 'data:image/png;base64,SIDE');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(full()).toHaveAttribute('src', 'data:image/png;base64,BACK');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(full()).toHaveAttribute('src', 'data:image/png;base64,job-1');
    fireEvent.keyDown(full(), { key: 'ArrowLeft' });
    expect(full()).toHaveAttribute('src', 'data:image/png;base64,BACK');
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(screen.queryByRole('img', { name: /full size$/ })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Redraw side and back views' }));
    });
    expect(extra.redrawAvatarViews).toHaveBeenCalledWith('job-1');
  });

  it('says why a take has no side and back views', async () => {
    const { api, mocks } = createApi([
      take('job-1', { views: {}, viewsMessage: 'Side and back views need Qwen-Image 2.1 in ComfyUI.' }),
    ]);
    (mocks as unknown as Record<string, unknown>).redrawAvatarViews = vi.fn();
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    expect(screen.queryByRole('img', { name: 'Take 1 side view' })).not.toBeInTheDocument();
    expect(screen.getByText('Side and back views need Qwen-Image 2.1 in ComfyUI.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draw side and back views' })).toBeInTheDocument();
  });

  it('sends warning acceptance only from the explicit build-anyway button', async () => {
    const { api, mocks } = createApi([
      take('job-1', {
        warnings: [{ code: 'face-width', message: 'Detected face width is 23.3%.' }],
      }),
    ]);
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    expect(screen.getByRole('alert', { name: 'Avatar compatibility warnings' })).toHaveTextContent(
      '23.3%',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept warnings and build anyway' }));
    });
    expect(mocks.confirmAvatarConcept).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ acceptWarnings: true }),
    );
  });

  it('shows a finished take beside its image, applies poses, and keeps it', async () => {
    const onAccepted = vi.fn();
    const { api, mocks } = createApi([
      take('job-1', {
        status: 'completed',
        progress: 1,
        geometryModelName: 'TRELLIS.2 (int8 convrot)',
        rigModelName: 'Blender auto-rig with fitted face',
        buildSeconds: 412,
      }),
    ]);
    render(
      <AvatarStudio avatarApi={api} onClose={vi.fn()} onAccepted={onAccepted} pollIntervalMs={5} />,
    );
    await settle();
    await settle();
    expect(mocks.loadGeneratedAvatarPreview).toHaveBeenCalledWith('job-1');
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('img', { name: 'Take 1 concept' })).toBeInTheDocument();
    expect(screen.getByText(/built in 6 min 52 s/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Happiness' }));
    });
    expect(mocks.loadPose).toHaveBeenCalledWith('builtin:happiness');
    expect(scene.pose).toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep this avatar' }));
    });
    expect(mocks.acceptGeneratedAvatar).toHaveBeenCalledWith('job-1');
    expect(onAccepted).toHaveBeenCalledWith('vrm-9');
    expect(screen.getByText('Take 1 is now your active avatar.')).toBeInTheDocument();
  });

  it('discards a take and keeps Escape inside the studio', async () => {
    const onClose = vi.fn();
    const { api, mocks } = createApi([take('job-1'), take('job-2')]);
    render(<AvatarStudio avatarApi={api} onClose={onClose} pollIntervalMs={5} />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard take 2' }));
    });
    expect(mocks.rejectGeneratedAvatar).toHaveBeenCalledWith('job-2');
    expect(within(screen.getByLabelText('Takes')).getAllByRole('button')).toHaveLength(1);
    const key = vi.fn();
    window.addEventListener('keydown', key);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Avatar studio' }), { key: 'Escape' });
    expect(key).not.toHaveBeenCalled();
    window.removeEventListener('keydown', key);
    fireEvent(
      screen.getByRole('dialog', { name: 'Avatar studio' }),
      new Event('cancel', { cancelable: true }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('polls while a take is running and shows the failure message', async () => {
    const { api, jobs } = createApi([take('job-1', { status: 'meshing', progress: 0.4 })]);
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    jobs.current = [
      take('job-1', { status: 'failed', errorMessage: 'Head cut produced more than one boundary' }),
    ];
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByText(/Head cut produced more than one boundary/)).toBeInTheDocument();
  });

  it('switches to side by side when the viewed take finishes building', async () => {
    const { api, jobs } = createApi([take('job-1', { status: 'meshing', progress: 0.4 })]);
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    expect(screen.getByRole('button', { name: 'Image' })).toHaveAttribute('aria-pressed', 'true');
    jobs.current = [take('job-1', { status: 'completed', progress: 1 })];
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('heading', { name: '3D avatar · take 1' })).toBeInTheDocument();
  });

  it('keeps take numbers when an earlier take is removed', async () => {
    const { api } = createApi([take('job-1', { takeNumber: 1 }), take('job-2', { takeNumber: 2 })]);
    render(<AvatarStudio avatarApi={api} onClose={vi.fn()} pollIntervalMs={5} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Take 1' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard take 1' }));
    });
    expect(screen.getByRole('button', { name: 'Take 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Image · take 2' })).toBeInTheDocument();
  });
});
