import { ConfigManager } from '../../config/config-manager.js';
import { AvatarGenerationService } from './avatar-generation-service.js';
import { AvatarImageModelService } from './image-model-service.js';
import { baseModelForFamily, suggestBaseModels } from './civitai.js';
import type { BaseModelSuggestions } from '../../shared/avatar/civitai-types.js';
import { AvatarCharacterModelService } from './character-model-service.js';
import type {
  AvatarGenerationRequest,
  AvatarGenerationJob,
  AvatarGenerationStatus,
  AvatarGenerationConfirmation,
  AvatarGenerationAcceptance,
} from '../../shared/avatar/types.js';
import { BUILT_IN_SERVER_IDS } from '../../shared/config/model-routing.js';
import { ComfyUIPool } from './comfyui-pool.js';
import type { HandleIpc } from '../../ipc/handle-ipc.js';

export interface AvatarGenerationIpcOptions {
  handle: HandleIpc;
  manager: ConfigManager;
  imageModels: () => AvatarImageModelService | undefined;
  characterModels: () => AvatarCharacterModelService | undefined;
  generation: () => AvatarGenerationService | null;
  comfyPool: () => ComfyUIPool | undefined;
}

export function registerAvatarGenerationIpc(options: AvatarGenerationIpcOptions): void {
  const { handle, manager, imageModels, characterModels, generation, comfyPool } = options;

  const requireAvatarGeneration = (): AvatarGenerationService => {
    const service = generation();
    if (!service) {
      throw new Error('Avatar generation is unavailable.');
    }
    return service;
  };
  handle('avatar:image-models', async () => {
    const avatarImageModels = imageModels();
    if (!avatarImageModels) throw new Error('Image models are unavailable.');
    return avatarImageModels.list();
  });
  handle('avatar:image-model-select', async (_event, id: string) => {
    const avatarImageModels = imageModels();
    if (!avatarImageModels) throw new Error('Image models are unavailable.');
    await avatarImageModels.select(id);
  });
  handle('avatar:image-loras-select', async (_event, choices: unknown) => {
    const avatarImageModels = imageModels();
    if (!avatarImageModels) throw new Error('Image models are unavailable.');
    avatarImageModels.selectLoras(Array.isArray(choices) ? choices : []);
  });
  // Popular Civitai checkpoints for a LoRA's base model, sized against the image server's GPU.
  handle(
    'avatar:base-model-suggestions',
    async (_event, payload: { baseModel?: unknown; family?: unknown }) => {
      const server = comfyPool()?.primary('image');
      if (!server) throw new Error('No ComfyUI server is set for the image step.');
      const baseModel =
        typeof payload?.baseModel === 'string' && payload.baseModel.trim()
          ? payload.baseModel.trim()
          : typeof payload?.family === 'string'
            ? baseModelForFamily(payload.family)
            : undefined;
      if (!baseModel)
        throw new Error("That LoRA's base model isn't known, so there is nothing to suggest.");
      const vramBytes = await fetch(`${server.url}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      })
        .then(async (response) =>
          response.ok
            ? ((await response.json()) as { devices?: Array<{ vram_total?: unknown }> })
            : null,
        )
        .then((stats) => {
          const total = stats?.devices?.[0]?.vram_total;
          return typeof total === 'number' && total > 0 ? total : null;
        })
        .catch(() => null);
      const suggestions = await suggestBaseModels(
        baseModel,
        vramBytes,
        manager.getServerKey(BUILT_IN_SERVER_IDS.civitai),
      );
      const result: BaseModelSuggestions = {
        serverId: server.id,
        serverName: server.name,
        baseModel,
        vramBytes,
        suggestions,
      };
      return result;
    },
  );
  handle('avatar:character-models', async () => {
    const avatarCharacterModels = characterModels();
    if (!avatarCharacterModels) throw new Error('3D avatar models are unavailable.');
    return avatarCharacterModels.list();
  });
  handle('avatar:character-model-select', async (_event, stage: 'geometry' | 'rig', id: string) => {
    const avatarCharacterModels = characterModels();
    if (!avatarCharacterModels) throw new Error('3D avatar models are unavailable.');
    await avatarCharacterModels.select(stage, id);
  });
  handle('avatar:generation-list', async (): Promise<AvatarGenerationStatus[]> =>
    requireAvatarGeneration().listJobs(),
  );
  handle('avatar:generation-cancel', async (_event, jobId: string): Promise<void> =>
    requireAvatarGeneration().cancel(jobId),
  );
  handle(
    'avatar:generation-start',
    async (_event, payload: AvatarGenerationRequest): Promise<AvatarGenerationJob> =>
      requireAvatarGeneration().startJob(payload),
  );
  handle('avatar:generation-remove-background', async (_event, jobId: string) =>
    requireAvatarGeneration().removeConceptBackground(jobId),
  );
  handle('avatar:generation-restore-background', async (_event, jobId: string) =>
    requireAvatarGeneration().restoreConceptBackground(jobId),
  );
  handle('avatar:generation-redraw-views', async (_event, jobId: string) =>
    requireAvatarGeneration().redrawViews(jobId),
  );
  handle(
    'avatar:generation-confirm-concept',
    async (_event, jobId: string, confirmation?: AvatarGenerationConfirmation): Promise<void> =>
      requireAvatarGeneration().confirmConcept(jobId, confirmation),
  );
  handle(
    'avatar:generation-status',
    async (_event, jobId: string): Promise<AvatarGenerationStatus> =>
      requireAvatarGeneration().getStatus(jobId),
  );
  handle('avatar:generation-preview', async (_event, jobId: string): Promise<Buffer> =>
    requireAvatarGeneration().loadPreview(jobId),
  );
  handle(
    'avatar:generation-accept',
    async (_event, jobId: string): Promise<AvatarGenerationAcceptance> =>
      requireAvatarGeneration().accept(jobId),
  );
  handle('avatar:generation-reject', async (_event, jobId: string): Promise<void> =>
    requireAvatarGeneration().reject(jobId),
  );
}
