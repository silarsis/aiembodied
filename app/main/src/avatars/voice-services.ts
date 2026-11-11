/**
 * One LocalVoiceService per avatar, made on first use. Each has its own conversation history,
 * brief, queued notes and recalled ids; the speech/LLM engines are shared, so a second avatar
 * does not load a second model. Engine changes reach every service.
 */
import type { LocalVoiceService } from '../local-voice/local-voice-service.js';
import { DEFAULT_AVATAR_ID } from './avatar-registry.js';

type Engines = Parameters<LocalVoiceService['configure']>[0];

export interface VoiceServicesOptions {
  /** Builds the service for an avatar. It should use the shared engines (see `engines`). */
  create(avatarId: string): LocalVoiceService;
}

export class VoiceServices {
  private readonly services = new Map<string, LocalVoiceService>();
  private readonly create: VoiceServicesOptions['create'];

  constructor(options: VoiceServicesOptions) {
    this.create = options.create;
  }

  get(avatarId: string = DEFAULT_AVATAR_ID): LocalVoiceService {
    const id = avatarId || DEFAULT_AVATAR_ID;
    let service = this.services.get(id);
    if (!service) {
      service = this.create(id);
      this.services.set(id, service);
    }
    return service;
  }

  has(avatarId: string = DEFAULT_AVATAR_ID): boolean {
    return this.services.has(avatarId);
  }

  /** Services made so far, with their avatar ids. */
  entries(): Array<[string, LocalVoiceService]> {
    return [...this.services.entries()];
  }

  /** Swap the shared engines in every service made so far. */
  configure(engines: Engines): void {
    let first = true;
    for (const service of this.services.values()) {
      service.configure(engines, { closeOldTts: first });
      first = false;
    }
  }

  /** Drop an avatar's service (its conversation goes with it). */
  delete(avatarId: string): void {
    this.services.delete(avatarId);
  }
}
