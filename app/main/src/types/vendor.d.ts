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

declare module 'three/examples/jsm/loaders/GLTFLoader.js' {
  import type { Loader, LoadingManager } from 'three';

  export interface GLTF {
    readonly userData: Record<string, unknown>;
    readonly parser?: unknown;
  }

  export class GLTFLoader extends Loader {
    constructor(manager?: LoadingManager);
    parseAsync(data: ArrayBuffer, path: string): Promise<GLTF>;
    register(callback: (parser: unknown) => unknown): this;
  }
}

declare module '@pixiv/three-vrm-core' {
  export interface VRM1Meta {
    metaVersion: '1';
    name?: string;
    version?: string;
  }

  export interface VRMMetaLoaderPluginOptions {
    acceptV0Meta?: boolean;
  }

  export class VRMMetaLoaderPlugin {
    acceptV0Meta: boolean;
    needThumbnailImage: boolean;
    constructor(parser: unknown, options?: VRMMetaLoaderPluginOptions);
  }
}
