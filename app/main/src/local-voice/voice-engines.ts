/** Build the conversation pipeline's engines from the provider settings. */
import type { ProviderSettings } from '../config/provider-settings.js';
import { LocalLlmClient, OPENAI_API_BASE_URL } from './local-llm-client.js';
import { OpenAiAudioClient } from './openai-audio-client.js';
import { OpenAiRealtimeTts, type RealtimeSocketFactory } from './openai-realtime-tts.js';
import { KokoroTts, OpenAiStt, SpeechServiceStt } from './speech-engines.js';
import type { SpeechToTextEngine, TextToSpeechEngine } from './speech-engines.js';
import { SpeechServiceClient } from './speech-service-client.js';

export interface VoiceEngines {
  llm: LocalLlmClient;
  speech: SpeechServiceClient;
  stt: SpeechToTextEngine;
  tts: TextToSpeechEngine;
}

export function buildVoiceEngines(
  providers: ProviderSettings,
  apiKey: string,
  options: { fetchFn?: typeof fetch; createSocket?: RealtimeSocketFactory; logger?: Pick<Console, 'warn'> } = {},
): VoiceEngines {
  const { fetchFn } = options;
  const speech = new SpeechServiceClient({ baseUrl: providers.speechServiceUrl, fetchFn });
  const openai = new OpenAiAudioClient({ apiKey, fetchFn });

  const llm =
    providers.llm.provider === 'openai'
      ? new LocalLlmClient({
          baseUrl: OPENAI_API_BASE_URL,
          model: providers.llm.openaiModel,
          apiKey,
          flavor: 'openai',
          fetchFn,
        })
      : new LocalLlmClient({ baseUrl: providers.llm.localBaseUrl, model: providers.llm.localModel, fetchFn });

  const stt: SpeechToTextEngine =
    providers.stt.provider === 'openai' ? new OpenAiStt(openai, providers.stt.openaiModel) : new SpeechServiceStt(speech);

  const tts: TextToSpeechEngine =
    providers.tts.provider === 'openai'
      ? new OpenAiRealtimeTts({
          apiKey,
          model: providers.tts.openaiModel,
          voice: providers.tts.openaiVoice,
          style: providers.tts.openaiInstructions,
          createSocket: options.createSocket,
          logger: options.logger,
        })
      : new KokoroTts(speech, providers.tts.kokoroVoice);

  return { llm, speech, stt, tts };
}
