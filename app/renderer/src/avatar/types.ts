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
  /** Shipped with the app and available without a saved library. */
  builtIn?: boolean;
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
  | 'awaiting_confirmation'
  | 'texturing'
  | 'meshing'
  | 'rigging'
  | 'packaging'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** How a model's front gets its A-pose; see the main process type for each value. */
export type AvatarImagePoseControl = 'guided' | 'installing' | 'failed' | 'unavailable' | 'prompt' | 'none';
export interface AvatarImageModelSummary {
  id: string;
  name: string;
  available: boolean;
  unavailableReason?: string;
  poseControl?: AvatarImagePoseControl;
  poseNote?: string;
}
export interface AvatarLoraSummary {
  name: string;
  title?: string;
  family?: string;
  baseModel?: string;
  triggerWords?: string[];
}
export interface AvatarLoraChoice {
  name: string;
  strength: number;
}
export interface AvatarImageModelSelection {
  models: AvatarImageModelSummary[];
  selectedModelId: string | null;
  modelFamilies?: Record<string, string>;
  loras?: AvatarLoraSummary[];
  selectedLoras?: AvatarLoraChoice[];
}
export interface BaseModelSuggestion {
  ref: string;
  modelId: number;
  versionId: number;
  name: string;
  baseModel: string;
  sizeKB: number;
  downloads: number;
  fits: boolean | null;
}
export interface BaseModelSuggestions {
  serverId: string;
  serverName: string;
  baseModel: string;
  vramBytes: number | null;
  suggestions: BaseModelSuggestion[];
}
export interface ModelDownloadProgress {
  id: string;
  filename: string;
  state: 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';
  received: number;
  total: number | null;
  error?: string;
}

export interface AvatarGenerationRequest {
  imageModelId?: string;
  mode?: 'new-character' | 'restyle';
  /** Plain-English description of the character's look. */
  prompt?: string;
  /** PNG base64; uploads skip text-to-image and still require concept confirmation. */
  referenceImage?: { mimeType: 'image/png'; data: string };
}

export interface AvatarGenerationJob {
  jobId: string;
}

export interface AvatarGenerationWarning {
  code: 'face-width' | 'face-height' | 'face-position';
  message: string;
}
export interface AvatarGenerationConfirmation {
  acceptWarnings?: boolean;
  /** 3D geometry model from listAvatarCharacterModels; the saved choice when omitted. */
  geometryModelId?: string;
  /** Rig and face-animation method from listAvatarCharacterModels; the saved choice when omitted. */
  rigModelId?: string;
}

export interface AvatarCharacterModelSummary {
  id: string;
  name: string;
  /** One line on what the option does, shown under the selector. */
  description?: string;
  /** A 3D model that is given side and back views too; those are drawn only by Qwen-Image. */
  views?: boolean;
  available: boolean;
  unavailableReason?: string;
}
/** Models that turn an approved image into a rigged, animated 3D avatar. */
export interface AvatarCharacterModelSelection {
  geometry: AvatarCharacterModelSummary[];
  rig: AvatarCharacterModelSummary[];
  selectedGeometryId: string | null;
  selectedRigId: string | null;
}

export interface AvatarGenerationStatus {
  jobId: string;
  status: AvatarGenerationStage;
  warnings?: AvatarGenerationWarning[];
  warningsAccepted?: boolean;
  /** 0..1 */
  progress: number;
  message?: string | null;
  /** Concept image as a PNG data URL, once it exists. */
  previewDataUrl?: string | null;
  backgroundRemoved?: boolean;
  /**
   * The checks on a new front: how many images were drawn for it, and what is still wrong with
   * the one shown (null when it passed).
   */
  frontCheck?: { attempts: number; problem: string | null };
  /**
   * The character's left side and back, drawn from the front image for 3D models that take
   * several views (PNG data URLs). Missing when they couldn't be drawn; viewsMessage says why.
   */
  views?: { left?: string | null; back?: string | null };
  viewsMessage?: string | null;
  errorMessage?: string | null;
  /** The description, or the name given to an upload. */
  prompt?: string;
  mode?: 'new-character' | 'restyle';
  source?: 'text' | 'upload';
  /** Milliseconds since the epoch; orders the takes in the studio history. */
  createdAt?: number;
  /** Stable number shown as "Take N"; not reused when other takes are removed. */
  takeNumber?: number;
  imageModelName?: string | null;
  /** Names of the 3D models used for the current or last build of this take. */
  geometryModelName?: string | null;
  rigModelName?: string | null;
  /** Seconds the last finished build took. */
  buildSeconds?: number | null;
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
  listAvatarImageModels(): Promise<AvatarImageModelSelection>;
  setAvatarImageModel(id: string): Promise<void>;
  setAvatarImageLoras?(choices: AvatarLoraChoice[]): Promise<void>;
  suggestBaseModels?(request: { baseModel?: string; family?: string }): Promise<BaseModelSuggestions>;
  downloadBaseModel?(serverId: string, ref: string): Promise<ModelDownloadProgress>;
  listModelDownloads?(): Promise<ModelDownloadProgress[]>;
  generateAvatar(request: AvatarGenerationRequest): Promise<AvatarGenerationJob>;
  getAvatarGenerationStatus(jobId: string): Promise<AvatarGenerationStatus>;
  confirmAvatarConcept(jobId: string, confirmation?: AvatarGenerationConfirmation): Promise<void>;
  loadGeneratedAvatarPreview(jobId: string): Promise<ArrayBuffer>;
  acceptGeneratedAvatar(jobId: string): Promise<AvatarGenerationAcceptance>;
  rejectGeneratedAvatar(jobId: string): Promise<void>;
  listAvatarGenerationJobs?(): Promise<AvatarGenerationStatus[]>;
  cancelAvatarGeneration?(jobId: string): Promise<void>;
  removeAvatarBackground?(jobId: string): Promise<void>;
  restoreAvatarBackground?(jobId: string): Promise<void>;
  /** Draw the side and back views again from the current front image. */
  redrawAvatarViews?(jobId: string): Promise<void>;
  listAvatarCharacterModels?(): Promise<AvatarCharacterModelSelection>;
  setAvatarCharacterModel?(stage: 'geometry' | 'rig', id: string): Promise<void>;
}
