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
  /** Clip length in seconds; only the local motion service uses it. */
  duration?: number;
  bones?: string[];
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
  id: string;
  name: string;
  createdAt: number;
  fileSha: string;
}

export interface AvatarPoseGenerationRequest {
  prompt: string;
  bones?: string[];
  modelDescription?: string;
}

export interface AvatarPoseUploadRequest {
  name: string;
  fileName: string;
  data: string; // JSON string of the pose data
}

export interface AvatarPoseUploadResult {
  pose: AvatarPoseSummary;
}

export type AvatarGenerationStage =
  | 'queued'
  | 'concept'
  | 'texturing'
  | 'packaging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AvatarGenerationRequest {
  /** Plain-English description of the character's look. */
  prompt: string;
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

/** Request to evaluate a pose against its original prompt using vision LLM */
export interface PoseEvaluationRequest {
  poseId: string;
  imageDataUrl: string;
  originalPrompt: string;
  userFeedback?: string;
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

export interface AvatarBridge {
  listModels(): Promise<AvatarModelSummary[]>;
  getActiveModel(): Promise<AvatarModelSummary | null>;
  setActiveModel(modelId: string | null): Promise<AvatarModelSummary | null>;
  uploadModel(request: AvatarModelUploadRequest): Promise<AvatarModelUploadResult>;
  deleteModel(modelId: string): Promise<void>;
  loadModelBinary(modelId: string): Promise<ArrayBuffer>;
  updateModelThumbnail(modelId: string, thumbnailDataUrl: string): Promise<AvatarModelSummary | null>;
  updateModelDescription(modelId: string, description: string): Promise<AvatarModelSummary | null>;
  generateModelDescription(thumbnailDataUrl: string): Promise<string>;
  listAnimations(): Promise<AvatarAnimationSummary[]>;
  uploadAnimation(request: AvatarAnimationUploadRequest): Promise<AvatarAnimationUploadResult>;
  generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult>;
  getMotionStatus?(): Promise<AvatarMotionStatus>;
  streamMotion?(request: AvatarMotionStreamRequest): Promise<AvatarMotionStreamResult>;
  onMotionChunk?(listener: (chunk: AvatarMotionChunkEvent) => void): () => void;
  deleteAnimation(animationId: string): Promise<void>;
  renameAnimation(animationId: string, newName: string): Promise<AvatarAnimationSummary>;
  loadAnimationBinary(animationId: string): Promise<ArrayBuffer>;
  loadAnimationBinary(animationId: string): Promise<ArrayBuffer>;
  triggerBehaviorCue(cue: string): Promise<void>;
  listPoses(): Promise<AvatarPoseSummary[]>;
  uploadPose(request: AvatarPoseUploadRequest): Promise<AvatarPoseUploadResult>;
  generatePose(request: AvatarPoseGenerationRequest): Promise<AvatarPoseUploadResult>;
  deletePose(poseId: string): Promise<void>;
  loadPose(poseId: string): Promise<unknown>;
  evaluatePose(request: PoseEvaluationRequest): Promise<PoseEvaluationResult>;
  refinePose(request: PoseEvaluationRequest): Promise<AvatarPoseUploadResult>;
  generateAvatar(request: AvatarGenerationRequest): Promise<AvatarGenerationJob>;
  getAvatarGenerationStatus(jobId: string): Promise<AvatarGenerationStatus>;
  acceptGeneratedAvatar(jobId: string): Promise<AvatarGenerationAcceptance>;
  rejectGeneratedAvatar(jobId: string): Promise<void>;
}
