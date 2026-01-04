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

export interface AvatarPoseSummary {
  id: string;
  name: string;
  createdAt: number;
  fileSha: string;
}

export interface AvatarPoseUploadRequest {
  name: string;
  fileName: string;
  data: string; // JSON string of the VRMPose
}

export interface AvatarPoseUploadResult {
  pose: AvatarPoseSummary;
}

export interface AvatarPoseGenerationRequest {
  prompt: string;
  bones?: string[];
  boneHierarchy?: Record<string, string | null>;
  modelDescription?: string;
}

// VRM 1.0 expression preset names
export type VrmExpressionPresetName =
  | 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised' | 'neutral'  // emotions
  | 'blink' | 'blinkLeft' | 'blinkRight'                              // eye states
  | 'lookUp' | 'lookDown' | 'lookLeft' | 'lookRight'                  // eye direction
  | 'aa' | 'ih' | 'ou' | 'ee' | 'oh';                                 // visemes

/** Facial expression state for a pose, using VRM 1.0 preset names */
export interface PoseExpressionState {
  presets?: Partial<Record<VrmExpressionPresetName, number>>;
  custom?: Record<string, number>;
}

/** Complete pose data including bones and expressions */
export interface AvatarPoseData {
  bones: Record<string, { rotation: number[]; position?: number[] | null }>;
  expressions?: PoseExpressionState;
}
