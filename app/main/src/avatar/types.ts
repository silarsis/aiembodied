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
  /** Clip length in seconds; only the local motion service uses it. */
  duration?: number;
  bones?: string[];
  modelDescription?: string;
}

/**
 * An avatar's rest skeleton: normalized humanoid bone positions in metres, Y up, facing +Z with
 * the character's left on +X. The motion service calibrates the arm swing to it.
 */
export type AvatarRestSkeleton = Record<
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'leftShoulder'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  | 'rightShoulder'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand',
  [number, number, number]
>;

export interface AvatarMotionStreamRequest {
  /** Caller-chosen id echoed on every chunk so concurrent streams can be told apart. */
  streamId: string;
  prompt: string;
  duration?: number;
  /** The avatar on screen, so the motion is calibrated to its build. */
  avatarRest?: AvatarRestSkeleton;
}

export interface AvatarMotionChunkEvent {
  streamId: string;
  index: number;
  /** Offset of this chunk in the whole movement, in seconds. */
  start: number;
  name: string;
  duration: number | null;
  /** Base64 .vrma binary. */
  data: string;
}

export interface AvatarMotionStreamResult {
  streamId: string;
  chunks: number;
  firstChunkMs: number | null;
  totalMs: number;
}

export interface AvatarMotionStatus {
  /** local: services/motion streams motion live; openai: clips are generated, never streamed. */
  provider?: 'local' | 'openai';
  available: boolean;
  /** Live motion streaming is ready (always false for OpenAI). */
  ready: boolean;
  backend: string | null;
  device: string | null;
  /** The OpenAI model, when the provider is OpenAI. */
  model?: string | null;
}

export interface AvatarPoseSummary {
  /** Shipped with the app and available without a saved library. */
  builtIn?: boolean;
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

export type AvatarGenerationStage =
  | 'queued'
  | 'concept'
  | 'awaiting_confirmation'
  | 'texturing'
  | 'meshing'
  | 'rigging'
  | 'packaging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AvatarGenerationRequest {
  mode?: 'new-character' | 'restyle';
  /** Plain-English description of the character's look. */
  prompt?: string;
  /** PNG base64; uploads skip text-to-image and still require concept confirmation. */
  referenceImage?: { mimeType: 'image/png'; data: string };
}

export interface AvatarGenerationJob {
  jobId: string;
}

export interface AvatarGenerationStatus {
  jobId: string;
  status: AvatarGenerationStage;
  /** 0..1 */
  progress: number;
  message?: string | null;
  /** Concept image as a PNG data URL, once it exists. */
  previewDataUrl?: string | null;
  errorMessage?: string | null;
}

export interface AvatarGenerationAcceptance {
  vrmId: string;
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
