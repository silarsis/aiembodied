declare module 'auto-launch' {
  export interface AutoLaunchOptions {
    name: string;
    path?: string;
    isHidden?: boolean;
    mac?: {
      useLaunchAgent?: boolean;
    };
  }

  export default class AutoLaunch {
    constructor(options: AutoLaunchOptions);
    enable(): Promise<void>;
    disable(): Promise<void>;
    isEnabled(): Promise<boolean>;
  }
}

declare module 'prom-client' {
  export interface CollectDefaultMetricsOptions {
    register?: Registry;
  }

  export function collectDefaultMetrics(options?: CollectDefaultMetricsOptions): void;

  export class Registry {
    contentType: string;
    registerMetric(metric: Histogram): void;
    metrics(): Promise<string>;
  }

  export interface HistogramConfiguration<T extends string = string> {
    name: string;
    help: string;
    buckets?: number[];
    labelNames?: T[];
    registers?: Registry[];
  }

  export class Histogram<T extends string = string> {
    constructor(configuration: HistogramConfiguration<T>);
    observe(value: number): void;
    observe(labels: Record<T, string>, value: number): void;
  }
}
