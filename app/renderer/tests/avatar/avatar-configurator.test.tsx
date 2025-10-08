import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AvatarConfigurator } from '../../src/avatar/avatar-configurator.js';
import type { AvatarBridge } from '../../src/avatar/types.js';

const SAMPLE_PREVIEW = 'data:image/png;base64,ZmFrZQ==';

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
    const uploadFace = vi.fn();

    const avatarApi: AvatarBridge = {
      listFaces,
      getActiveFace,
      setActiveFace,
      deleteFace,
      uploadFace,
    };

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
    const uploadFace = vi.fn().mockResolvedValue({ faceId: 'face-2' });
    const setActiveFace = vi.fn();
    const deleteFace = vi.fn();

    const avatarApi: AvatarBridge = {
      listFaces,
      getActiveFace,
      uploadFace,
      setActiveFace,
      deleteFace,
    };

    const originalFileReader = globalThis.FileReader;
    const mockDataUrl = 'data:image/png;base64,bmV3ZmFjZQ==';

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

    try {
      globalThis.FileReader = FileReaderMock as unknown as typeof FileReader;

      const onActive = vi.fn();
      render(<AvatarConfigurator avatarApi={avatarApi} onActiveFaceChange={onActive} />);

      const file = new File([Uint8Array.from([1, 2, 3])], 'friendly.png', { type: 'image/png' });
      const fileInput = await screen.findByLabelText('Face image');
      fireEvent.change(fileInput, { target: { files: [file] } });

      const form = screen.getByRole('form', { name: 'Upload new avatar face' });
      fireEvent.submit(form);

      await waitFor(() => expect(uploadFace).toHaveBeenCalledTimes(1));
      expect(uploadFace).toHaveBeenCalledWith({ name: 'friendly', imageDataUrl: mockDataUrl });
      await waitFor(() => expect(listFaces).toHaveBeenCalledTimes(2));
    } finally {
      globalThis.FileReader = originalFileReader;
    }
  });
});
