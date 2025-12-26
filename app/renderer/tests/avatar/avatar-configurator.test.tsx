import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AvatarConfigurator } from '../../src/avatar/avatar-configurator.js';
import type { AvatarBridge, AvatarGenerationResult, AvatarModelSummary } from '../../src/avatar/types.js';

const SAMPLE_PREVIEW = 'data:image/png;base64,ZmFrZQ==';

function mockFileReader(mockDataUrl: string) {
  const originalFileReader = globalThis.FileReader;

  class FileReaderMock {
    public result: string | ArrayBuffer | null = null;
    public onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    public onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL() {
      this.result = mockDataUrl;
      const event = { target: this } as unknown as ProgressEvent<FileReader>;
      this.onload?.call(this as unknown as FileReader, event);
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'load') {
        this.onload = listener as (this: FileReader, ev: ProgressEvent<FileReader>) => unknown;
      }
      if (type === 'error') {
        this.onerror = listener as (this: FileReader, ev: ProgressEvent<FileReader>) => unknown;
      }
    }

    removeEventListener() {}

    abort() {}

    dispatchEvent() {
      return true;
    }
  }

  globalThis.FileReader = FileReaderMock as unknown as typeof FileReader;

  return () => {
    globalThis.FileReader = originalFileReader;
  };
}

function createAvatarBridgeStub(overrides: Partial<AvatarBridge> = {}): AvatarBridge {
  return {
    listFaces: vi.fn().mockResolvedValue([]),
    getActiveFace: vi.fn().mockResolvedValue(null),
    setActiveFace: vi.fn().mockResolvedValue(null),
    generateFace: vi
      .fn()
      .mockResolvedValue({ generationId: 'gen-stub', candidates: [] } as AvatarGenerationResult),
    applyGeneratedFace: vi.fn().mockResolvedValue({ faceId: 'stub' }),
    deleteFace: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    getActiveModel: vi.fn().mockResolvedValue(null),
    setActiveModel: vi.fn().mockResolvedValue(null),
    uploadModel: vi.fn().mockResolvedValue({
      model: {
        id: 'vrm-stub',
        name: 'Stub',
        createdAt: Date.now(),
        version: '1.0',
        fileSha: 'stub',
        thumbnailDataUrl: null,
      },
    }),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    updateModelThumbnail: vi.fn().mockResolvedValue(null),
    listAnimations: vi.fn().mockResolvedValue([]),
    uploadAnimation: vi.fn().mockResolvedValue({
      animation: {
        id: 'vrma-stub',
        name: 'Stub Animation',
        createdAt: Date.now(),
        fileSha: 'stub',
        duration: null,
        fps: null,
      },
    }),
    generateAnimation: vi.fn().mockResolvedValue({
      animation: {
        id: 'vrma-generated',
        name: 'wave-hello',
        createdAt: Date.now(),
        fileSha: 'stub',
        duration: 1,
        fps: 30,
      },
    }),
    deleteAnimation: vi.fn().mockResolvedValue(undefined),
    loadAnimationBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    getDisplayModePreference: vi.fn().mockResolvedValue('sprites'),
    setDisplayModePreference: vi.fn().mockResolvedValue(undefined),
    triggerBehaviorCue: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('AvatarConfigurator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders stored faces and supports selection and deletion', async () => {
    const faces = [
      {
        id: 'face-1',
        name: 'Happy Face',
        createdAt: 1735689600000,
        previewDataUrl: SAMPLE_PREVIEW,
      },
    ];

    const listFaces = vi.fn().mockResolvedValueOnce(faces).mockResolvedValueOnce([]);
    const getActiveFace = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const setActiveFace = vi.fn().mockResolvedValue({
      id: 'face-1',
      name: 'Happy Face',
      createdAt: faces[0].createdAt,
      components: [],
    });
    const deleteFace = vi.fn().mockResolvedValue(undefined);
    const generateFace = vi.fn().mockResolvedValue({ generationId: 'gen-1', candidates: [{ id: 'cand-1', strategy: 'responses', previewDataUrl: SAMPLE_PREVIEW, componentsCount: 9, qualityScore: 100 }] } as AvatarGenerationResult);
    const applyGeneratedFace = vi.fn().mockResolvedValue({ faceId: 'face-1' });

    const avatarApi = createAvatarBridgeStub({
      listFaces,
      getActiveFace,
      setActiveFace,
      deleteFace,
      generateFace,
      applyGeneratedFace,
    });

    const onActive = vi.fn();

    render(<AvatarConfigurator avatarApi={avatarApi} onActiveFaceChange={onActive} />);

    await waitFor(() => expect(screen.getByText('Happy Face')).toBeInTheDocument());
    expect(onActive).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByRole('button', { name: 'Use face' }));
    await waitFor(() => expect(setActiveFace).toHaveBeenCalledWith('face-1'));
    expect(onActive).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'face-1', name: 'Happy Face' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteFace).toHaveBeenCalledWith('face-1'));
    expect(listFaces).toHaveBeenCalledTimes(2);
  });

  it('uploads a new face image and refreshes the listing', async () => {
    const listFaces = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'face-2',
        name: 'Uploaded Face',
        createdAt: 1735689700000,
        previewDataUrl: SAMPLE_PREVIEW,
      },
    ]);
    const getActiveFace = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'face-2',
      name: 'Uploaded Face',
      createdAt: 1735689700000,
      components: [],
    });
    const generateFace = vi.fn().mockResolvedValue({ generationId: 'gen-2', candidates: [{ id: 'cand-2', strategy: 'responses', previewDataUrl: SAMPLE_PREVIEW, componentsCount: 9, qualityScore: 100 }] } as AvatarGenerationResult);
    const applyGeneratedFace = vi.fn().mockResolvedValue({ faceId: 'face-2' });
    const setActiveFace = vi.fn();
    const deleteFace = vi.fn();

    const avatarApi = createAvatarBridgeStub({
      listFaces,
      getActiveFace,
      generateFace,
      applyGeneratedFace,
      setActiveFace,
      deleteFace,
    });

    const mockDataUrl = 'data:image/png;base64,bmV3ZmFjZQ==';

    const restoreFileReader = mockFileReader(mockDataUrl);
    try {
      const onActive = vi.fn();
      render(<AvatarConfigurator avatarApi={avatarApi} onActiveFaceChange={onActive} />);

      const file = new File([Uint8Array.from([1, 2, 3])], 'friendly.png', { type: 'image/png' });
      const fileInput = await screen.findByLabelText('Face image');
      fireEvent.change(fileInput, { target: { files: [file] } });

      const form = screen.getByRole('form', { name: 'Upload new avatar face' });
      fireEvent.submit(form);

      await waitFor(() => expect(generateFace).toHaveBeenCalledTimes(1));
      const applyBtn = await screen.findByRole('button', { name: 'Apply' });
      fireEvent.click(applyBtn);
      await waitFor(() => expect(applyGeneratedFace).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(listFaces).toHaveBeenCalledTimes(2));
    } finally {
      restoreFileReader();
    }
  });

  it('shows uploading state while generation is pending without blocking other controls', async () => {
    const listFaces = vi.fn().mockResolvedValue([]);
    const getActiveFace = vi.fn().mockResolvedValue(null);
    let resolveGeneration: ((value: AvatarGenerationResult) => void) | undefined;
    const generateFace = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<AvatarGenerationResult>((resolve) => {
            resolveGeneration = resolve;
          }),
      );
    const applyGeneratedFace = vi.fn().mockResolvedValue({ faceId: 'generated' });
    const setActiveFace = vi.fn();
    const deleteFace = vi.fn();

    const avatarApi = createAvatarBridgeStub({
      listFaces,
      getActiveFace,
      generateFace,
      applyGeneratedFace,
      setActiveFace,
      deleteFace,
    });

    const restoreFileReader = mockFileReader('data:image/png;base64,cGVuZGluZw==');

    try {
      const toggleSpy = vi.fn();
      render(
        <>
          <button type="button" onClick={toggleSpy}>
            Listening toggle
          </button>
          <AvatarConfigurator avatarApi={avatarApi} />
        </>,
      );

      const file = new File([Uint8Array.from([4, 5, 6])], 'pending.png', { type: 'image/png' });
      const fileInput = await screen.findByLabelText('Face image');
      fireEvent.change(fileInput, { target: { files: [file] } });

      const form = screen.getByRole('form', { name: 'Upload new avatar face' });
      fireEvent.submit(form);

      expect(screen.getByRole('button', { name: 'Generating…' })).toBeInTheDocument();

      const toggleButton = screen.getByRole('button', { name: 'Listening toggle' });
      fireEvent.click(toggleButton);
      expect(toggleSpy).toHaveBeenCalledTimes(1);

      await waitFor(() => expect(generateFace).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('button', { name: 'Generating…' })).toBeInTheDocument();

      expect(resolveGeneration).toBeDefined();
      resolveGeneration?.({ generationId: 'pending-gen', candidates: [] });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Generate avatar' })).toBeEnabled(),
      );
    } finally {
      restoreFileReader();
    }
  });

  it('submits a VRMA prompt and reports success', async () => {
    const listFaces = vi.fn().mockResolvedValue([]);
    const getActiveFace = vi.fn().mockResolvedValue(null);
    const listModels = vi.fn().mockResolvedValue([]);
    const getActiveModel = vi.fn().mockResolvedValue(null);
    const generateAnimation = vi.fn().mockResolvedValue({
      animation: {
        id: 'vrma-1',
        name: 'friendly-wave',
        createdAt: Date.now(),
        fileSha: 'sha',
        duration: 1.2,
        fps: 30,
      },
    });

    const avatarApi = createAvatarBridgeStub({
      listFaces,
      getActiveFace,
      listModels,
      getActiveModel,
      generateAnimation,
    });

    render(<AvatarConfigurator avatarApi={avatarApi} panel="3d" />);

    const promptInput = await screen.findByLabelText('Animation prompt');
    fireEvent.change(promptInput, { target: { value: 'Wave hello' } });

    const form = screen.getByRole('form', { name: 'Generate VRMA animation' });
    fireEvent.submit(form);

    await waitFor(() => expect(generateAnimation).toHaveBeenCalledWith({ prompt: 'Wave hello' }));
    expect(await screen.findByText('Generated animation saved as friendly-wave.')).toBeInTheDocument();
  });

  it('renders VRM models with metadata and handles activation and deletion', async () => {
    const models = [
      {
        id: 'vrm-1',
        name: 'Model One',
        createdAt: 1735689600000,
        version: '1.0',
        fileSha: '0123456789abcdef',
        thumbnailDataUrl: SAMPLE_PREVIEW,
      },
      {
        id: 'vrm-2',
        name: 'Model Two',
        createdAt: 1735689700000,
        version: '2.0',
        fileSha: 'fedcba9876543210',
        thumbnailDataUrl: null,
      },
    ];

    const listModels = vi.fn().mockResolvedValueOnce(models).mockResolvedValueOnce([models[1]]);
    const getActiveModel = vi
      .fn()
      .mockResolvedValueOnce(models[0])
      .mockResolvedValueOnce(models[1]);
    const setActiveModel = vi.fn().mockResolvedValue(models[1]);
    const deleteModel = vi.fn().mockResolvedValue(undefined);

    const avatarApi = createAvatarBridgeStub({
      listModels,
      getActiveModel,
      setActiveModel,
      deleteModel,
    });

    render(<AvatarConfigurator avatarApi={avatarApi} panel="3d" />);

    await waitFor(() => expect(screen.getByText('Model One')).toBeInTheDocument());
    expect(screen.getByText('Model Two')).toBeInTheDocument();
    expect(screen.getByText('0123456789ab…')).toBeInTheDocument();

    const modelTwoCard = screen.getByRole('heading', { name: 'Model Two' }).closest('article');
    expect(modelTwoCard).not.toBeNull();
    if (!modelTwoCard) {
      throw new Error('VRM card not found');
    }

    const useModelButton = within(modelTwoCard).getByRole('button', { name: 'Use model' });
    fireEvent.click(useModelButton);
    await waitFor(() => expect(setActiveModel).toHaveBeenCalledWith('vrm-2'));

    const deleteButton = within(screen.getByRole('heading', { name: 'Model One' }).closest('article')!).getByRole(
      'button',
      { name: 'Delete' },
    );
    fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith('vrm-1'));
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    expect(getActiveModel).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText('Model One')).not.toBeInTheDocument());
  });

  it('uploads a VRM file and surfaces metadata from the main service', async () => {
    const uploadedModel = {
      id: 'vrm-uploaded',
      name: 'Friendly VRM',
      createdAt: 1735689900000,
      version: '1.1',
      fileSha: 'aaaaaaaaaaaaaaaabbbb',
      thumbnailDataUrl: SAMPLE_PREVIEW,
    } satisfies AvatarModelSummary;

    const listModels = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([uploadedModel]);
    const getActiveModel = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(uploadedModel);
    const uploadModel = vi.fn().mockResolvedValue({ model: uploadedModel });

    const avatarApi = createAvatarBridgeStub({ listModels, getActiveModel, uploadModel });

    const restoreFileReader = mockFileReader('data:application/octet-stream;base64,QUJD');
    try {
      render(<AvatarConfigurator avatarApi={avatarApi} panel="3d" />);

      const file = new File([Uint8Array.from([1, 2, 3])], 'avatar.vrm', { type: 'application/octet-stream' });
      const fileInput = await screen.findByLabelText('VRM file');
      fireEvent.change(fileInput, { target: { files: [file] } });

      const vrmForm = screen.getByRole('form', { name: 'Upload new VRM model' });
      const nameInput = within(vrmForm).getByLabelText('Display name');
      fireEvent.change(nameInput, { target: { value: 'Friendly VRM' } });

      fireEvent.submit(vrmForm);

      await waitFor(() => expect(uploadModel).toHaveBeenCalledTimes(1));
      expect(uploadModel).toHaveBeenCalledWith({
        fileName: 'avatar.vrm',
        data: 'QUJD',
        name: 'Friendly VRM',
      });

      await screen.findByText('Upload complete');
      expect(screen.getByText('Friendly VRM · v1.1')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Friendly VRM thumbnail' })).toBeInTheDocument();
    } finally {
      restoreFileReader();
    }
  });

  it('prevents non-vrm uploads and shows validation error', async () => {
    const uploadModel = vi.fn();
    const avatarApi = createAvatarBridgeStub({ uploadModel });

    render(<AvatarConfigurator avatarApi={avatarApi} panel="3d" />);

    const invalidFile = new File([Uint8Array.from([1])], 'avatar.png', { type: 'image/png' });
    const fileInput = await screen.findByLabelText('VRM file');
    fireEvent.change(fileInput, { target: { files: [invalidFile] } });

    const form = screen.getByRole('form', { name: 'Upload new VRM model' });
    fireEvent.submit(form);

    expect(screen.getByRole('alert')).toHaveTextContent('VRM upload rejected: file must use the .vrm extension.');
    expect(uploadModel).not.toHaveBeenCalled();
  });

  it('logs a warning when the avatar bridge is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      await act(async () => {
        render(<AvatarConfigurator />);
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[avatar configurator] Avatar bridge unavailable. Falling back to static UI.',
      );
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('logs connection info when the avatar bridge is provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      const avatarApi = createAvatarBridgeStub({
        listFaces: vi.fn().mockResolvedValue([]),
        getActiveFace: vi.fn().mockResolvedValue(null),
        setActiveFace: vi.fn().mockResolvedValue(null),
        generateFace: vi.fn().mockResolvedValue({ generationId: 'gen-x', candidates: [] } as AvatarGenerationResult),
        applyGeneratedFace: vi.fn().mockResolvedValue({ faceId: 'id' }),
        deleteFace: vi.fn().mockResolvedValue(undefined),
      });

      await act(async () => {
        render(<AvatarConfigurator avatarApi={avatarApi} />);
      });
      await waitFor(() => expect(infoSpy).toHaveBeenCalled());
      expect(warnSpy).not.toHaveBeenCalledWith(
        '[avatar configurator] Avatar bridge unavailable. Falling back to static UI.',
      );
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
