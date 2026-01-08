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
  bones?: string[];
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
  generateMovementTimeline?(request: SpeechMovementRequest): Promise<MovementTimeline>;
  generateSinglePose?(request: StreamingPoseRequest): Promise<SinglePoseResult>;
  generateFastPose?(request: FastPoseRequest): Promise<FastPoseResult>;
}

/** Request to generate a movement timeline from speech */
export interface SpeechMovementRequest {
  transcript: string;
  speechDuration?: number;
  modelDescription?: string;
  bones?: string[];
  boneHierarchy?: Record<string, string | null>;
}

/** Keyframe in a movement timeline */
export interface MovementKeyframe {
  time: number;
  pose: {
    bones: Record<string, { rotation: number[]; position?: number[] | null }>;
    expressions?: {
      presets?: Partial<Record<
        'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised' | 'neutral',
        number
      >>;
    };
  };
  emotion?: string;
}

/** Timeline of movement keyframes for speech-driven animation */
export interface MovementTimeline {
  duration: number;
  keyframes: MovementKeyframe[];
}

/** Request to generate a single pose from streaming text */
export interface StreamingPoseRequest {
  recentText: string;
  fullContext?: string;
  modelDescription?: string;
  bones?: string[];
  boneHierarchy?: Record<string, string | null>;
}

/** Result of single pose generation */
export interface SinglePoseResult {
  pose: {
    bones: Record<string, { rotation: number[]; position?: number[] | null }>;
    expressions?: {
      presets?: Partial<Record<
        'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised' | 'neutral',
        number
      >>;
    };
  };
  emotion?: string;
}

/** Request for fast pose generation (uses pose library) */
export interface FastPoseRequest {
  recentText: string;
  availablePoses: string[];
}

/** Result of fast pose generation */
export interface FastPoseResult {
  type: 'preset' | 'raw';
  presetSlug?: string;
  pose?: {
    bones: Record<string, { rotation: number[]; position?: number[] | null }>;
    expressions?: {
      presets?: Partial<Record<
        'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised' | 'neutral',
        number
      >>;
    };
  };
  emotion?: string;
}
