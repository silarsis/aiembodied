export type AvatarComponentSlot =
  | 'base'
  | 'eyes-open'
  | 'eyes-closed'
  | 'mouth-neutral'
  | 'mouth-0'
  | 'mouth-1'
  | 'mouth-2'
  | 'mouth-3'
  | 'mouth-4';

export interface AvatarFaceSummary {
  id: string;
  name: string;
  createdAt: number;
  previewDataUrl: string | null;
}

export interface AvatarComponentAsset {
  slot: AvatarComponentSlot;
  sequence: number;
  mimeType: string;
  dataUrl: string;
}

export interface AvatarFaceDetail {
  id: string;
  name: string;
  createdAt: number;
  components: AvatarComponentAsset[];
}

export interface AvatarUploadRequest {
  name?: string;
  imageDataUrl: string;
}

export interface AvatarUploadResult {
  faceId: string;
}

export interface AvatarBridge {
  listFaces(): Promise<AvatarFaceSummary[]>;
  getActiveFace(): Promise<AvatarFaceDetail | null>;
  setActiveFace(faceId: string | null): Promise<AvatarFaceDetail | null>;
  uploadFace(request: AvatarUploadRequest): Promise<AvatarUploadResult>;
  deleteFace(faceId: string): Promise<void>;
}
