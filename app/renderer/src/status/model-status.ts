import type { LocalVoiceStatus } from '../../../main/src/local-voice/types.js';
import type { AvatarMotionStatus } from '../avatar/types.js';
import type { ModelStatus } from './assistant-status.js';

/**
 * The models in use, from the voice and motion status checks: the LLM, speech-to-text, text-to-
 * speech and motion, each local or OpenAI. A check that failed outright (`null`) shows its models
 * as not running.
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
  const sttState: ModelStatus['state'] = stt?.provider === 'openai'
    ? stt.available
      ? 'ready'
      : 'down'
    : stt?.url
    ? stt.available
      ? 'ready'
      : 'down'
    : speechState;

  const tts = voice?.tts;
  const ttsState: ModelStatus['state'] = tts?.provider === 'openai' ? (tts.available ? 'ready' : 'down') : speechState;

  const motionOnOpenAi = motion?.provider === 'openai';
  const motionState: ModelStatus['state'] = !motion?.available
    ? 'down'
    : motion.ready || motionOnOpenAi
      ? 'ready'
      : 'loading';
  const openAi = (model: string | null | undefined) => (model ? `OpenAI ${model}` : 'OpenAI');

  return [
    {
      id: 'llm',
      label: 'Language model',
      state: voice?.llm.available ? 'ready' : 'down',
      model: voice?.llm.provider === 'openai' ? openAi(voice.llm.model) : (voice?.llm.model ?? null),
      detail:
        voice && !voice.llm.available
          ? voice.llm.provider === 'openai'
            ? 'no OpenAI API key'
            : `not answering at ${voice.llm.baseUrl}`
          : null,
    },
    {
      id: 'stt',
      label: 'Speech-to-text',
      state: sttState,
      model: stt?.provider === 'openai' ? openAi(stt.model) : (stt?.model ?? speech?.sttModel ?? null),
      detail:
        stt?.provider === 'openai'
          ? stt.available
            ? null
            : 'no OpenAI API key'
          : stt?.url && !stt.available
            ? `not answering at ${stt.url}`
            : null,
    },
    {
      id: 'tts',
      label: 'Text-to-speech',
      state: ttsState,
      model:
        tts?.provider === 'openai'
          ? `${openAi(tts.model)} ${tts.voice ?? ''}`.trim()
          : [tts?.model ?? speech?.ttsModel, tts?.voice ?? speech?.defaultVoice].filter(Boolean).join(' ') || null,
      detail: tts?.provider === 'openai' ? tts.error : (speech?.error ?? null),
    },
    {
      id: 'motion',
      label: 'Motion',
      state: motionState,
      model: motionOnOpenAi ? openAi(motion?.model) : (motion?.backend ?? null),
      detail: motionOnOpenAi ? (motion?.available ? 'clips only, no live motion' : 'no OpenAI API key') : motion?.ready ? motion.device : null,
    },
  ];
}
