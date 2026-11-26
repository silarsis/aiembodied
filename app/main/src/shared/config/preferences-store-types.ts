// Types only: shared/ holds what the main process and the renderer both need.
import type { CodingConfig } from '../coding/types.js';
import type { StoredModels } from './model-routing.js';
import type { ProviderSettingsPatch } from './provider-settings.js';

export interface AudioDevicePreferences {
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
  realtimeModel?: string;
  realtimeVoice?: string;
  sessionInstructions?: string;
  vadTurnDetection?: 'none' | 'server_vad';
  vadThreshold?: number;
  vadSilenceDurationMs?: number;
  vadMinSpeechDurationMs?: number;
  conversationBackend?: 'local' | 'openai';
  /** The provider settings the user changed on the Settings page (see provider-settings.ts). */
  providers?: ProviderSettingsPatch;
  /** Added model servers and which server runs each use (see model-routing.ts). */
  models?: StoredModels;
  /** The coding runner, its workspaces and the coder model file (see coding/config.ts). */
  coding?: CodingConfig;
}
