export interface VadControllerOptions {
  activationThreshold: number;
  releaseMs: number;
}

export interface VadUpdateResult {
  isActive: boolean;
  changed: boolean;
}

export class VadController {
  private isActive = false;
  private lastActiveAt = 0;

  constructor(private readonly options: VadControllerOptions) {}

  update(level: number, timestampMs: number): VadUpdateResult {
    if (Number.isNaN(level) || !Number.isFinite(level)) {
      return { isActive: this.isActive, changed: false };
    }

    if (level >= this.options.activationThreshold) {
      const changed = !this.isActive;
      this.isActive = true;
      this.lastActiveAt = timestampMs;
      return { isActive: true, changed };
    }

    if (this.isActive && timestampMs - this.lastActiveAt <= this.options.releaseMs) {
      return { isActive: true, changed: false };
    }

    const changed = this.isActive;
    this.isActive = false;
    return { isActive: false, changed };
  }

  reset() {
    this.isActive = false;
    this.lastActiveAt = 0;
  }
}
