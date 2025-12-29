export interface AvatarModelSummary {
  id: string;
  name: string;
  createdAt: number;
  version: string;
  fileSha: string;
  thumbnailDataUrl: string | null;
  description: string | null;
}

export interface AvatarModelUploadRequest {
  name?: string;
  fileName: string;
  data: string; // base64 encoded binary contents
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
  modelDescription?: string;
}
