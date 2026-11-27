import { ConfigManager } from '../../config/config-manager.js';
import { MotionTraceSink } from '../../logging/motion-trace.js';
import { LocalMotionGenerationService } from './local-motion-generation-service.js';
import { AicontrollerBridge } from '../../aicontroller/bridge.js';
import type { AvatarMotionStatus, AvatarMotionStreamRequest } from '../../shared/avatar/types.js';
import { routeTargets } from '../../shared/config/model-routing.js';
import type { HandleIpc } from '../../ipc/handle-ipc.js';
import type { OnIpc } from '../../ipc/handle-ipc.js';

export interface AvatarMotionIpcOptions {
  handle: HandleIpc;
  on: OnIpc;
  manager: ConfigManager;
  aicontroller: AicontrollerBridge;
  localMotion: () => LocalMotionGenerationService | null;
  localMotionServer: () => object | null;
  motionTrace: MotionTraceSink;
}

export function registerAvatarMotionIpc(options: AvatarMotionIpcOptions): void {
  const { handle, on, manager, aicontroller, localMotion, localMotionServer, motionTrace } =
    options;

  const motionStreamControllers = new Map<string, AbortController>();
  handle('avatar-motion:status', async (): Promise<AvatarMotionStatus> => {
    if (!localMotionServer()) {
      const clips = routeTargets(manager.getConfig().models, 'clips')[0];
      return {
        provider: 'openai',
        available: Boolean(
          clips && (clips.server.type !== 'openai' || manager.getServerKey(clips.server.id)),
        ),
        ready: false,
        backend: null,
        device: null,
        model: clips?.model ?? null,
      };
    }
    await aicontroller.ensureMotion().catch(() => undefined);
    const motion = localMotion();
    const health = motion ? await motion.health() : null;
    return {
      provider: 'local',
      available: Boolean(health),
      ready: health?.ready === true,
      backend: health?.backend ?? null,
      device: health?.device ?? null,
    };
  });
  handle('avatar-motion:stream', async (event, payload: AvatarMotionStreamRequest) => {
    await aicontroller.ensureMotion().catch(() => undefined);
    const motion = localMotion();
    if (!motion || !localMotionServer()) {
      throw new Error('Local motion service is unavailable.');
    }

    const sender = event.sender;
    const controller = new AbortController();
    motionStreamControllers.set(payload.streamId, controller);
    try {
      return await motion.streamMotion(
        payload,
        (chunk) => {
          if (!sender.isDestroyed()) {
            sender.send('avatar-motion:chunk', chunk);
          }
        },
        { signal: controller.signal },
      );
    } finally {
      motionStreamControllers.delete(payload.streamId);
    }
  });
  // Motion trace: the renderer sends batches of lines, and the UI setting (the env var also counts).
  on('motion-trace:append', (_event, lines: unknown) => motionTrace.append(lines));
  handle('motion-trace:configure', (_event, settingOn: unknown) =>
    motionTrace.configure(settingOn === true),
  );
  handle('avatar-motion:cancel', (_event, streamId: unknown) => {
    if (typeof streamId === 'string') {
      motionStreamControllers.get(streamId)?.abort();
    }
  });
}
