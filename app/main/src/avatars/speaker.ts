/**
 * Stamps the speaking avatar on everything main sends the renderer for a voice turn, so the
 * renderer can play each avatar's voice on its own output. Echo is always stamped too; a missing
 * id on the renderer side still means `echo`.
 */
import type { LocalVoiceEvent, LocalVoiceRespondResult } from '../local-voice/types.js';

export function tagEvent(event: LocalVoiceEvent, avatarId: string): LocalVoiceEvent {
  return { ...event, avatarId };
}

export function tagResult(result: LocalVoiceRespondResult, avatarId: string): LocalVoiceRespondResult {
  return { ...result, avatarId };
}
