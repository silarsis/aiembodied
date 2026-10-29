import type { LocalVoiceStatus } from '../../../main/src/local-voice/types.js';
import type { AvatarMotionStatus } from '../avatar/types.js';
import type { ModelStatus } from './assistant-status.js';

/**
 * The local models, from the voice and motion status checks: the LLM, speech-to-text, text-to-
 * speech and motion. A check that failed outright (`null`) shows its models as not running.
 */
export function describeModels(voice: LocalVoiceStatus | null, motion: AvatarMotionStatus | null): ModelStatus[] {
  const speech = voice?.speech;
  const speechState: ModelStatus['state'] = !speech?.available
    ? 'down'
    : speech.error
      ? 'error'
      : speech.ready
        ? 'ready'
        : 'loading';

  // The speech service loads its own STT unless it forwards to a separate server.
  const stt = voice?.stt;
  const sttState: ModelStatus['state'] = stt?.url
    ? stt.available
      ? 'ready'
      : 'down'
    : speechState;

  const motionState: ModelStatus['state'] = !motion?.available ? 'down' : motion.ready ? 'ready' : 'loading';

  return [
    {
      id: 'llm',
      label: 'Language model',
      state: voice?.llm.available ? 'ready' : 'down',
      model: voice?.llm.model ?? null,
      detail: voice && !voice.llm.available ? `not answering at ${voice.llm.baseUrl}` : null,
    },
    {
      id: 'stt',
      label: 'Speech-to-text',
      state: sttState,
      model: stt?.model ?? speech?.sttModel ?? null,
      detail: stt?.url && !stt.available ? `not answering at ${stt.url}` : null,
    },
    {
      id: 'tts',
      label: 'Text-to-speech',
      state: speechState,
      model: [speech?.ttsModel, speech?.defaultVoice].filter(Boolean).join(' ') || null,
      detail: speech?.error ?? null,
    },
    {
      id: 'motion',
      label: 'Motion',
      state: motionState,
      model: motion?.backend ?? null,
      detail: motion?.ready ? motion.device : null,
    },
  ];
}
