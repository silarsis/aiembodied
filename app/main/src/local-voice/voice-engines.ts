/** Build the conversation pipeline's engines from the provider settings. */
import type { ProviderSettings } from '../config/provider-settings.js';
import { LocalLlmClient, OPENAI_API_BASE_URL } from './local-llm-client.js';
import { OpenAiAudioClient } from './openai-audio-client.js';
import { KokoroTts, OpenAiStt, OpenAiTts, SpeechServiceStt } from './speech-engines.js';
import type { SpeechToTextEngine, TextToSpeechEngine } from './speech-engines.js';
import { SpeechServiceClient } from './speech-service-client.js';

export interface VoiceEngines {
  llm: LocalLlmClient;
  speech: SpeechServiceClient;
  stt: SpeechToTextEngine;
  tts: TextToSpeechEngine;
}

export function buildVoiceEngines(providers: ProviderSettings, apiKey: string, fetchFn?: typeof fetch): VoiceEngines {
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
      ? new OpenAiTts(openai, {
          model: providers.tts.openaiModel,
          voice: providers.tts.openaiVoice,
          instructions: providers.tts.openaiInstructions,
        })
      : new KokoroTts(speech, providers.tts.kokoroVoice);

  return { llm, speech, stt, tts };
}
