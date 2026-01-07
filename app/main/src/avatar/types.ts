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

/** Request to evaluate a pose against its original prompt using vision LLM */
export interface PoseEvaluationRequest {
  poseId: string;
  poseData: AvatarPoseData;
  imageDataUrl: string;
  originalPrompt: string;
  userFeedback?: string;
  modelDescription?: string;
  bones?: string[];
  boneHierarchy?: Record<string, string | null>;
  /** Previous evaluation result to include in refinement context */
  previousEvaluation?: PoseEvaluationResult;
}

/** Result of pose evaluation with feedback and optional refined pose */
export interface PoseEvaluationResult {
  meetsRequirement: boolean;
  feedback: string;
  suggestedImprovements?: string[];
  refinedPoseId?: string;
}

// ============================================================================
// Speech-Driven Movement Types
// ============================================================================

/** A single keyframe in a movement timeline */
export interface MovementKeyframe {
  /** Time offset in seconds from start of speech */
  time: number;
  /** Target pose at this keyframe */
  pose: AvatarPoseData;
  /** Optional emotion hint for the keyframe */
  emotion?: string;
}

/** A timeline of movements synchronized to speech */
export interface MovementTimeline {
  /** Total duration in seconds */
  duration: number;
  /** Ordered list of keyframes */
  keyframes: MovementKeyframe[];
}

/** Delay mode for synchronizing speech with movement animation */
export type SpeechMovementDelayMode = 'none' | 'short' | 'full';

/** Request to generate a movement timeline from speech transcript */
export interface SpeechMovementRequest {
  /** The speech transcript to generate movements for */
  transcript: string;
  /** Estimated speech duration in seconds (helps with timing) */
  speechDuration?: number;
  /** Description of the avatar model for context */
  modelDescription?: string;
  /** List of available bone names */
  bones?: string[];
  /** Bone hierarchy mapping (child -> parent) */
  boneHierarchy?: Record<string, string | null>;
  /** Current pose to transition from */
  currentPose?: AvatarPoseData;
}
