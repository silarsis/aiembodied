export type AvatarDisplayMode = 'sprites' | 'vrm';

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

export interface AvatarModelSummary {
  id: string;
  name: string;
  createdAt: number;
  version: string;
  fileSha: string;
  thumbnailDataUrl: string | null;
}

export interface AvatarModelUploadRequest {
  name?: string;
  fileName: string;
  data: string;
}

export interface AvatarModelUploadResult {
  model: AvatarModelSummary;
}

export interface AvatarAnimationSummary {
  id: string;
  name: string;
  createdAt: number;
  fileSha: string;
  duration: number | null;
  fps: number | null;
}

export interface AvatarAnimationUploadRequest {
  name?: string;
  fileName: string;
  data: string;
}

export interface AvatarAnimationUploadResult {
  animation: AvatarAnimationSummary;
}

export interface AvatarAnimationGenerationRequest {
  prompt: string;
  bones?: string[];
}

export interface AvatarBridge {
  listFaces(): Promise<AvatarFaceSummary[]>;
  getActiveFace(): Promise<AvatarFaceDetail | null>;
  setActiveFace(faceId: string | null): Promise<AvatarFaceDetail | null>;
  generateFace(request: AvatarUploadRequest): Promise<AvatarGenerationResult>;
  applyGeneratedFace(generationId: string, candidateId: string, name?: string): Promise<AvatarUploadResult>;
  deleteFace(faceId: string): Promise<void>;
  listModels(): Promise<AvatarModelSummary[]>;
  getActiveModel(): Promise<AvatarModelSummary | null>;
  setActiveModel(modelId: string | null): Promise<AvatarModelSummary | null>;
  uploadModel(request: AvatarModelUploadRequest): Promise<AvatarModelUploadResult>;
  deleteModel(modelId: string): Promise<void>;
  loadModelBinary(modelId: string): Promise<ArrayBuffer>;
  listAnimations(): Promise<AvatarAnimationSummary[]>;
  uploadAnimation(request: AvatarAnimationUploadRequest): Promise<AvatarAnimationUploadResult>;
  generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult>;
  deleteAnimation(animationId: string): Promise<void>;
  loadAnimationBinary(animationId: string): Promise<ArrayBuffer>;
  getDisplayModePreference(): Promise<AvatarDisplayMode>;
  setDisplayModePreference(mode: AvatarDisplayMode): Promise<void>;
  triggerBehaviorCue(cue: string): Promise<void>;
}
