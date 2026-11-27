import type { WebContents } from 'electron';
import { FloorController } from '../floor/index.js';
import { HOME_PLACE_ID, PlaceManager, scopedPlaces } from '../places/place-manager.js';
import { chooseSummon, summon } from '../places/summon.js';
import { AvatarRegistry, DEFAULT_AVATAR_ID } from '../avatars/avatar-registry.js';
import { tagEvent, tagResult } from '../avatars/speaker.js';
import { ConfigManager } from '../config/config-manager.js';
import { AicontrollerBridge } from '../aicontroller/bridge.js';
import { LocalVoiceService } from './local-voice-service.js';
import type {
  LocalVoiceEvent,
  LocalVoiceRespondRequest,
  LocalVoiceRespondResult,
} from '../shared/local-voice/types.js';
import { BUILT_IN_SERVER_IDS, routeTargets } from '../shared/config/model-routing.js';
import { CodingService } from '../coding/coding-service.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

/** The avatar id an IPC call names; Echo when it names none. */
function avatarIdArg(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_AVATAR_ID;
}

export interface LocalVoiceIpcOptions {
  handle: HandleIpc;
  localVoiceService: () => LocalVoiceService | null;
  getVoiceService: (avatarId?: string) => LocalVoiceService | null;
  voiceConfigManager: () => ConfigManager | null;
  aicontroller: AicontrollerBridge;
  codingService: () => CodingService | null;
  placeManager: () => PlaceManager | null;
  avatarRegistry: () => AvatarRegistry | null;
  placeOf: (event: unknown) => string;
  floorFor: (placeId: string) => FloorController | null;
  noteEchoInstructions: (placeId: string, instructions: string) => void;
  setFloorSender: (sender: WebContents) => void;
  runVoiceTurn: (
    sender: WebContents,
    payload: LocalVoiceRespondRequest,
    service: LocalVoiceService,
    placeId: string,
  ) => Promise<LocalVoiceRespondResult>;
}

export function registerLocalVoiceIpc(options: LocalVoiceIpcOptions): void {
  const {
    handle,
    localVoiceService,
    getVoiceService,
    voiceConfigManager,
    aicontroller,
    codingService,
    placeManager,
    avatarRegistry,
    placeOf,
    floorFor,
    noteEchoInstructions,
    setFloorSender,
    runVoiceTurn,
  } = options;

  handle('local-voice:status', async () => {
    const service = localVoiceService();
    if (!service) {
      throw new Error('Local voice service is unavailable.');
    }
    return service.status();
  });
  handle('local-voice:transcribe', async (_event, audio: ArrayBuffer | Uint8Array) => {
    const service = localVoiceService();
    if (!service) {
      throw new Error('Local voice service is unavailable.');
    }
    const wav = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    return service.transcribe(wav);
  });
  handle('local-voice:respond', async (event, request: LocalVoiceRespondRequest) => {
    let payload = request;
    // The caller's place: a desktop room's turns are decided among the avatars there, by that place's floor.
    const placeId = placeOf(event);
    const isLocalPlace = placeId === (placeManager()?.localPlaceId() ?? HOME_PLACE_ID);
    const floor = floorFor(placeId);
    const voiceService = getVoiceService(avatarIdArg(payload?.avatarId));
    if (!voiceService) {
      throw new Error('Local voice service is unavailable.');
    }
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.text !== 'string') {
      throw new Error('Invalid local voice request payload received.');
    }
    const avatarId = voiceService.avatarId;

    // Kevin's own speech or typing (not a system update or a preview): the coder model gives way to it.
    const ownTurn = !payload.system && !payload.preview;
    const coding = codingService();
    if (ownTurn) coding?.noteActivity();
    const sender = event.sender;
    // The coder model has Echo's place: the tasks are paused and Echo's model is coming back. Say so, and wait for it.
    if (ownTurn && coding?.swapReclaiming()) {
      const message = 'Hang on, I’m busy, be with you in a sec…';
      const send = (voiceEvent: LocalVoiceEvent) => {
        if (!sender.isDestroyed()) sender.send('local-voice:event', tagEvent(voiceEvent, avatarId));
      };
      if (!sender.isDestroyed()) sender.send('coding:busy', { busy: true, message });
      try {
        await voiceService.speakOnly(payload.requestId, message, send);
        await coding.waitForEcho(15 * 60_000);
      } finally {
        if (!sender.isDestroyed()) sender.send('coding:busy', { busy: false });
      }
    }
    const configManager = voiceConfigManager();
    // The model controller may have taken Echo's lease back (a game, an eviction): lease it again, or fail the turn with the reason.
    if (
      configManager &&
      routeTargets(configManager.getConfig().models, 'llm')[0]?.server.id ===
        BUILT_IN_SERVER_IDS.llm
    ) {
      await aicontroller.ensureEcho();
    }
    if (
      !payload.preview &&
      !payload.system &&
      avatarId === DEFAULT_AVATAR_ID &&
      payload.instructions?.trim()
    ) {
      noteEchoInstructions(placeId, payload.instructions);
    }
    // Places: an avatar that is somewhere else walks in first, then answers.
    let turnService = voiceService;
    let turnAvatarId = avatarId;
    const places = placeManager();
    const scoped = places ? scopedPlaces(places, placeId) : null;
    if (places && scoped && floor && ownTurn) {
      if (isLocalPlace) setFloorSender(sender);
      const named = payload.avatarId?.trim() ? avatarId : null;
      let callId: string | null = null;
      if (named && !scoped.isPresent(named)) {
        callId = named;
      } else if (!named && places.avatarsAt(placeId).length === 0) {
        // Nobody is here: call the avatar Kevin last talked with, else Echo, else the first one.
        callId = chooseSummon(
          floor.recentPartner(),
          (avatarRegistry()?.list() ?? []).map((profile) => profile.id),
        );
      }
      if (callId) {
        const came = await summon(scoped, callId, 'summoned');
        if (!came) {
          const name = avatarRegistry()?.get(callId)?.name ?? callId;
          if (!sender.isDestroyed()) {
            sender.send(
              'local-voice:event',
              tagEvent(
                {
                  requestId: payload.requestId,
                  type: 'error',
                  message: `${name} did not come over.`,
                },
                callId,
              ),
            );
          }
          return tagResult({ requestId: payload.requestId, text: '', cancelled: true }, callId);
        }
        // Kevin named nobody: the avatar that came answers (alone, so there is nothing for the floor to decide).
        if (!named) {
          const summoned = getVoiceService(callId);
          if (!summoned) throw new Error('Local voice service is unavailable.');
          turnService = summoned;
          turnAvatarId = callId;
          payload = { ...payload, avatarId: callId };
        }
      }
    }
    // Several avatars here, or some away, and Kevin named none: the floor manager decides who answers.
    if (floor && ownTurn && !payload.avatarId?.trim() && (floor.isMulti() || floor.hasAway())) {
      if (isLocalPlace) setFloorSender(sender);
      return floor.respondToPerson(payload);
    }
    const result = await runVoiceTurn(sender, payload, turnService, placeId);
    // Kevin named an avatar directly: the others in the scene overhear the exchange.
    if (
      floor &&
      ownTurn &&
      payload.avatarId?.trim() &&
      floor.isMulti() &&
      !result.cancelled &&
      result.text.trim()
    ) {
      floor.heard('person', payload.text, turnAvatarId);
      floor.heard(turnAvatarId, result.text);
    }
    return result;
  });
  handle('local-voice:cancel', (_event, requestId?: string, avatarId?: unknown) => {
    getVoiceService(avatarIdArg(avatarId))?.cancel(
      typeof requestId === 'string' ? requestId : undefined,
    );
    return true;
  });
  handle(
    'local-voice:system-status',
    (_event, avatarId?: unknown) =>
      getVoiceService(avatarIdArg(avatarId))?.systemStatus() ?? {
        pending: 0,
        ready: false,
        texts: [],
        urgent: false,
      },
  );
  handle('local-voice:reset', (_event, avatarId?: unknown) => {
    getVoiceService(avatarIdArg(avatarId))?.resetHistory();
    return true;
  });
}
