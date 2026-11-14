/**
 * The pieces of a satellite's own answers that need nothing from the system, shared by the Electron satellite
 * (satellite.ts) and the web satellite (renderer/src/web-satellite). No Electron, no Node.
 */
import { DEFAULT_PROVIDER_SETTINGS } from '../config/provider-settings.js';
import type { RendererConfig } from '../config/config-manager.js';
import type { AudioDevicePreferences } from '../config/preferences-store.js';

export const DEFAULT_KEYWORD = 'Hey Echo';

/**
 * The config the page asks for on a satellite: no keys, no services, just enough for it to know what it is.
 * `keyword` is the wake word label bija sent in its welcome. `kind: 'browser'` marks a web page.
 */
export function satelliteConfig(input: { keyword?: unknown; audioPreferences?: AudioDevicePreferences; kind?: 'browser' }): RendererConfig {
  const { keyword, audioPreferences = {}, kind } = input;
  const config = {
    role: 'satellite',
    ...(kind ? { satelliteKind: kind } : {}),
    conversationBackend: 'local',
    providers: structuredClone(DEFAULT_PROVIDER_SETTINGS),
    hasRealtimeApiKey: false,
    featureFlags: {},
    wakeWord: { model: 'hey_echo', keywordLabel: typeof keyword === 'string' && keyword ? keyword : DEFAULT_KEYWORD, threshold: 0.5, cooldownMs: 1500 },
    metrics: { enabled: false, host: '127.0.0.1', port: 9464, path: '/metrics' },
    ...audioPreferences,
  };
  // The pieces the renderer reads are all here; the rest of RendererConfig is optional for it.
  return config as unknown as RendererConfig;
}

/** The wake word label inside a welcome's `settings.wakeWord`, if bija sent one. */
export function keywordOf(wakeWord: unknown): unknown {
  return (wakeWord as { keywordLabel?: unknown } | null | undefined)?.keywordLabel;
}

/**
 * Local channels whose answer on a satellite is always the same: no wake words to list or listen for, no latency
 * metrics, nothing to approve, no room being made in the background. Both satellites answer these alike.
 */
export const EMPTY_LOCAL_ANSWERS: Record<string, (args: unknown[]) => unknown> = {
  'wake-word:list': () => [],
  'wake-word:set-listening': () => undefined,
  'metrics:observe-latency': () => undefined,
  'approvals:list': () => [],
  'rooms:making': () => null,
};
