import { AvatarModelService } from './avatar-model-service.js';
import { AvatarAnimationService } from './avatar-animation-service.js';
import { VrmaGenerationService } from './vrma-generation-service.js';
import { AvatarPoseService } from './avatar-pose-service.js';
import { PoseGenerationService } from './pose-generation-service.js';
import { PoseEvaluationService } from './pose-evaluation-service.js';
import { AvatarDescriptionService } from './avatar-description-service.js';
import { LocalMotionGenerationService } from './motion/local-motion-generation-service.js';
import { AicontrollerBridge } from '../aicontroller/bridge.js';
import type {
  AvatarModelSummary,
  AvatarModelUploadRequest,
  AvatarModelUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationUploadRequest,
  AvatarAnimationUploadResult,
  AvatarAnimationGenerationRequest,
  AvatarPoseSummary,
  AvatarPoseUploadRequest,
  AvatarPoseGenerationRequest,
  PoseEvaluationRequest,
} from '../shared/avatar/types.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';
import type { Logger } from 'winston';

export interface CameraDetectionEventPayload {
  cue: string;
  timestamp?: number;
  confidence?: number;
  provider?: string;
  payload?: Record<string, unknown> | null;
}

export interface AvatarIpcOptions {
  handle: HandleIpc;
  avatarModels: AvatarModelService | null;
  avatarAnimations: AvatarAnimationService | null;
  avatarPoses: AvatarPoseService | null;
  aicontroller: AicontrollerBridge;
  localMotion: () => LocalMotionGenerationService | null;
  localMotionServer: () => object | null;
  ensureAvatarDescriptionService: () => Promise<AvatarDescriptionService | null>;
  ensureVrmaGenerationService: () => Promise<VrmaGenerationService | null>;
  ensurePoseGenerationService: () => Promise<PoseGenerationService | null>;
  ensurePoseEvaluationService: () => Promise<PoseEvaluationService | null>;
  withVision: <T>(use: 'describe' | 'posecheck', job: () => Promise<T>) => Promise<T>;
  emitCameraDetection: (event: CameraDetectionEventPayload) => boolean;
  logger: Logger;
}

export function registerAvatarIpc(options: AvatarIpcOptions): void {
  const {
    handle,
    avatarModels,
    avatarAnimations,
    avatarPoses,
    aicontroller,
    localMotion,
    localMotionServer,
    ensureAvatarDescriptionService,
    ensureVrmaGenerationService,
    ensurePoseGenerationService,
    ensurePoseEvaluationService,
    withVision,
    emitCameraDetection,
    logger,
  } = options;

  handle('avatar-model:list', async () => {
    if (!avatarModels) {
      return [] as AvatarModelSummary[];
    }

    return avatarModels.listModels();
  });
  handle('avatar-model:get-active', async () => {
    if (!avatarModels) {
      return null;
    }

    return avatarModels.getActiveModel();
  });
  handle('avatar-model:set-active', async (_event, modelId: string | null) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.setActiveModel(modelId);
  });
  handle('avatar-model:upload', async (_event, payload: AvatarModelUploadRequest) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.uploadModel(payload) as Promise<AvatarModelUploadResult>;
  });
  handle('avatar-model:delete', async (_event, modelId: string) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    await avatarModels.deleteModel(modelId);
    return true;
  });
  handle('avatar-model:load', async (_event, modelId: string) => {
    if (!avatarModels) {
      throw new Error('Avatar model service is unavailable.');
    }

    return avatarModels.loadModelBinary(modelId);
  });
  handle(
    'avatar-model:update-thumbnail',
    async (_event, payload: { modelId: string; thumbnailDataUrl: string }) => {
      if (!avatarModels) {
        throw new Error('Avatar model service is unavailable.');
      }

      return avatarModels.updateThumbnail(payload.modelId, payload.thumbnailDataUrl);
    },
  );
  handle(
    'avatar-model:update-description',
    async (_event, payload: { modelId: string; description: string }) => {
      if (!avatarModels) {
        throw new Error('Avatar model service is unavailable.');
      }

      return avatarModels.updateDescription(payload.modelId, payload.description);
    },
  );
  handle(
    'avatar-model:generate-description',
    async (_event, payload: { thumbnailDataUrl: string }) => {
      const service = await ensureAvatarDescriptionService();
      if (!service) {
        throw new Error(
          'Describe the avatar has no model to use. Pick one in Models and servers → Describe the avatar (or add the OpenAI API key if it runs on OpenAI).',
        );
      }

      return withVision('describe', () => service.generateDescription(payload.thumbnailDataUrl));
    },
  );
  handle('avatar-animation:list', async () => {
    if (!avatarAnimations) {
      return [] as AvatarAnimationSummary[];
    }

    return avatarAnimations.listAnimations();
  });
  handle('avatar-animation:upload', async (_event, payload: AvatarAnimationUploadRequest) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.uploadAnimation(payload) as Promise<AvatarAnimationUploadResult>;
  });
  handle('avatar-animation:generate', async (_event, payload: AvatarAnimationGenerationRequest) => {
    const useLocalMotion = localMotionServer() !== null;
    // The model controller may have taken the motion lease back: lease it again (a failure shows as "not ready" below).
    if (useLocalMotion) await aicontroller.ensureMotion().catch(() => undefined);
    const motion = localMotion();
    if (useLocalMotion && motion && (await motion.isReady())) {
      return motion.generateAnimation(payload);
    }

    const vrmaService = await ensureVrmaGenerationService();
    if (!vrmaService) {
      throw new Error(
        useLocalMotion
          ? 'Animation generation is unavailable. Start the motion service, or set up Animation clips in Models and servers.'
          : 'Animation clips need a server: choose one in Models and servers (OpenAI needs its API key).',
      );
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;
    return vrmaService.generateAnimation({ ...payload, bones, modelDescription });
  });
  handle('avatar-animation:delete', async (_event, animationId: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    await avatarAnimations.deleteAnimation(animationId);
    return true;
  });
  handle('avatar-animation:rename', async (_event, animationId: string, newName: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.renameAnimation(animationId, newName);
  });
  handle('avatar-animation:load', async (_event, animationId: string) => {
    if (!avatarAnimations) {
      throw new Error('Avatar animation service is unavailable.');
    }

    return avatarAnimations.loadAnimationBinary(animationId);
  });
  handle('avatar-pose:list', async () => {
    if (!avatarPoses) {
      return [] as AvatarPoseSummary[];
    }

    return avatarPoses.listPoses();
  });
  handle('avatar-pose:upload', async (_event, payload: AvatarPoseUploadRequest) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    return avatarPoses.uploadPose(payload);
  });
  handle('avatar-pose:generate', async (_event, payload: AvatarPoseGenerationRequest) => {
    const poseService = await ensurePoseGenerationService();
    if (!poseService) {
      throw new Error('Pose generation service is unavailable. Ensure REALTIME_API_KEY is set.');
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const boneHierarchy = avatarModels ? await avatarModels.listActiveModelBoneHierarchy() : {};
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;
    return poseService.generatePose({
      ...payload,
      bones,
      boneHierarchy,
      modelDescription,
    });
  });
  handle('avatar-pose:delete', async (_event, poseId: string) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    await avatarPoses.deletePose(poseId);
    return true;
  });
  handle('avatar-pose:load', async (_event, poseId: string) => {
    if (!avatarPoses) {
      throw new Error('Avatar pose service is unavailable.');
    }

    return avatarPoses.loadPose(poseId);
  });
  handle('avatar-pose:evaluate', async (_event, payload: PoseEvaluationRequest) => {
    const evaluator = await ensurePoseEvaluationService();
    if (!evaluator) {
      throw new Error(
        'Check poses has no model to use. Pick one in Models and servers (or add the OpenAI API key if it runs on OpenAI).',
      );
    }

    // Load pose data if only poseId is provided
    let poseData = payload.poseData;
    if (!poseData && payload.poseId && avatarPoses) {
      poseData = (await avatarPoses.loadPose(payload.poseId)) as typeof poseData;
    }
    if (!poseData) {
      throw new Error('Pose data is required for evaluation.');
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const boneHierarchy = avatarModels ? await avatarModels.listActiveModelBoneHierarchy() : {};
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;

    return withVision('posecheck', () =>
      evaluator.evaluatePose({
        ...payload,
        poseData,
        bones,
        boneHierarchy,
        modelDescription,
      }),
    );
  });
  handle('avatar-pose:refine', async (_event, payload: PoseEvaluationRequest) => {
    const evaluator = await ensurePoseEvaluationService();
    if (!evaluator) {
      throw new Error(
        'Check poses has no model to use. Pick one in Models and servers (or add the OpenAI API key if it runs on OpenAI).',
      );
    }

    // Load pose data if only poseId is provided
    let poseData = payload.poseData;
    if (!poseData && payload.poseId && avatarPoses) {
      poseData = (await avatarPoses.loadPose(payload.poseId)) as typeof poseData;
    }
    if (!poseData) {
      throw new Error('Pose data is required for refinement.');
    }

    const bones = avatarModels ? await avatarModels.listActiveModelBones() : [];
    const boneHierarchy = avatarModels ? await avatarModels.listActiveModelBoneHierarchy() : {};
    const activeModel = avatarModels?.getActiveModel() ?? null;
    const modelDescription = activeModel?.description ?? undefined;

    return withVision('posecheck', () =>
      evaluator.refinePose({
        ...payload,
        poseData,
        bones,
        boneHierarchy,
        modelDescription,
      }),
    );
  });
  handle('avatar:trigger-behavior', async (_event, cue: string) => {
    const value = typeof cue === 'string' ? cue.trim() : '';
    if (!value) {
      throw new Error('Invalid avatar behavior cue received.');
    }

    logger.info('Avatar behavior cue requested.', { cue: value });
    emitCameraDetection({
      cue: value,
      timestamp: Date.now(),
      confidence: 1,
      provider: 'behavior-trigger',
      payload: { origin: 'avatar:trigger-behavior' },
    });
    return true;
  });
  handle('camera:emit-detection', async (_event, payload: CameraDetectionEventPayload) => {
    if (!payload || typeof payload.cue !== 'string') {
      throw new Error('Invalid camera detection payload received.');
    }

    const cue = payload.cue.trim();
    if (!cue) {
      throw new Error('Camera detection cue cannot be empty.');
    }

    const emitted = emitCameraDetection({
      cue,
      timestamp: payload.timestamp,
      confidence: payload.confidence,
      provider: payload.provider ?? 'camera-bridge',
      payload: payload.payload ?? null,
    });

    return emitted;
  });
}
