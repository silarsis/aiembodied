import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AvatarConfigurator } from '../../src/avatar/avatar-configurator.js';
import type { AvatarBridge, AvatarModelSummary } from '../../src/avatar/types.js';

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

    removeEventListener() { }

    abort() { }

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
        description: null,
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
    renameAnimation: vi.fn().mockResolvedValue({
      id: 'vrma-stub',
      name: 'Renamed Animation',
      createdAt: Date.now(),
      fileSha: 'stub',
      duration: 1,
      fps: 30,
    }),
    loadAnimationBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    triggerBehaviorCue: vi.fn().mockResolvedValue(undefined),
    updateModelDescription: vi.fn().mockResolvedValue(null),
    generateModelDescription: vi.fn().mockResolvedValue(''),
    listPoses: vi.fn().mockResolvedValue([]),
    uploadPose: vi.fn().mockResolvedValue({
      pose: {
        id: 'pose-stub',
        name: 'default',
        createdAt: Date.now(),
        fileSha: 'stub',
      },
    }),
    generatePose: vi.fn().mockResolvedValue({
      pose: {
        id: 'pose-stub',
        name: 'power-stance',
        createdAt: Date.now(),
        fileSha: 'stub',
      },
    }),
    deletePose: vi.fn().mockResolvedValue(undefined),
    loadPose: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('AvatarConfigurator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits a VRMA prompt and reports success', async () => {
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
      listModels,
      getActiveModel,
      generateAnimation,
    });

    render(<AvatarConfigurator avatarApi={avatarApi} />);

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
        description: null,
      },
      {
        id: 'vrm-2',
        name: 'Model Two',
        createdAt: 1735689700000,
        version: '2.0',
        fileSha: 'fedcba9876543210',
        thumbnailDataUrl: null,
        description: null,
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

    render(<AvatarConfigurator avatarApi={avatarApi} />);

    await waitFor(() => expect(screen.getByText('Model One')).toBeInTheDocument());
    expect(screen.getByText('Model Two')).toBeInTheDocument();

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
      description: null,
    } satisfies AvatarModelSummary;

    const listModels = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([uploadedModel]);
    const getActiveModel = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(uploadedModel);
    const uploadModel = vi.fn().mockResolvedValue({ model: uploadedModel });

    const avatarApi = createAvatarBridgeStub({ listModels, getActiveModel, uploadModel });

    const restoreFileReader = mockFileReader('data:application/octet-stream;base64,QUJD');
    try {
      render(<AvatarConfigurator avatarApi={avatarApi} />);

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

    render(<AvatarConfigurator avatarApi={avatarApi} />);

    const invalidFile = new File([Uint8Array.from([1])], 'avatar.png', { type: 'image/png' });
    const fileInput = await screen.findByLabelText('VRM file');
    fireEvent.change(fileInput, { target: { files: [invalidFile] } });

    const form = screen.getByRole('form', { name: 'Upload new VRM model' });
    fireEvent.submit(form);

    expect(screen.getByRole('alert')).toHaveTextContent('VRM upload rejected: file must use the .vrm extension.');
    expect(uploadModel).not.toHaveBeenCalled();
  });

  it('logs a warning when the avatar bridge is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => { });

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => { });

    try {
      const avatarApi = createAvatarBridgeStub();

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
