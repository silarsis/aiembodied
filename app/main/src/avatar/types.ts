export const AVATAR_COMPONENT_SLOTS = [
  'base',
  'eyes-open',
  'eyes-closed',
  'mouth-neutral',
  'mouth-0',
  'mouth-1',
  'mouth-2',
  'mouth-3',
  'mouth-4',
] as const;

export type AvatarComponentSlot = (typeof AVATAR_COMPONENT_SLOTS)[number];

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

export type AvatarGenerationStrategy = 'responses' | 'images_edit';

export interface AvatarGenerationCandidateSummary {
  id: string;
  strategy: AvatarGenerationStrategy;
  previewDataUrl: string | null;
  componentsCount: number;
  qualityScore: number;
}

export interface AvatarGenerationResult {
  generationId: string;
  candidates: AvatarGenerationCandidateSummary[];
}
