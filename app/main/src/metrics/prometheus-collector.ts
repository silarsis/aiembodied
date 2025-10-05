import http from 'node:http';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import type { LatencyMetricName } from './types.js';

export interface PrometheusCollectorOptions {
  host?: string;
  port?: number;
  path?: string;
  logger?: {
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
}

export class PrometheusCollector {
  private readonly registry = new Registry();

  private readonly host: string;

  private readonly port: number;

  private readonly path: string;

  private readonly logger?: PrometheusCollectorOptions['logger'];

  private server: http.Server | null = null;

  private readonly wakeToCapture: Histogram<string>;

  private readonly captureToFirstAudio: Histogram<string>;

  private readonly wakeToFirstAudio: Histogram<string>;

  constructor(options: PrometheusCollectorOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 9477;
    this.path = options.path ?? '/metrics';
    this.logger = options.logger;

    collectDefaultMetrics({ register: this.registry });

    const buckets = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

    this.wakeToCapture = new Histogram({
      name: 'aiembodied_wake_to_capture_seconds',
      help: 'Latency from wake word detection to microphone capture activation.',
      buckets,
      registers: [this.registry],
    });

    this.captureToFirstAudio = new Histogram({
      name: 'aiembodied_capture_to_first_audio_seconds',
      help: 'Latency from microphone capture activation to first assistant audio playback.',
      buckets,
      registers: [this.registry],
    });

    this.wakeToFirstAudio = new Histogram({
      name: 'aiembodied_wake_to_first_audio_seconds',
      help: 'Latency from wake word detection to first assistant audio playback.',
      buckets,
      registers: [this.registry],
    });
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer(async (request, response) => {
      const method = request.method ?? 'GET';
      if (method !== 'GET') {
        response.statusCode = 405;
        response.setHeader('Content-Type', 'text/plain');
        response.end('Method Not Allowed');
        return;
      }

      const requestUrl = request.url ?? this.path;
      const url = new URL(requestUrl, `http://${request.headers.host ?? `${this.host}:${this.port}`}`);
      if (url.pathname !== this.path) {
        response.statusCode = 404;
        response.setHeader('Content-Type', 'text/plain');
        response.end('Not Found');
        return;
      }

      try {
        const metrics = await this.registry.metrics();
        response.statusCode = 200;
        response.setHeader('Content-Type', this.registry.contentType);
        response.end(metrics);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to serialize metrics.';
        this.logger?.error('Failed to serialize metrics', { message });
        response.statusCode = 500;
        response.setHeader('Content-Type', 'text/plain');
        response.end('Internal Server Error');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', (error) => {
        this.logger?.error('Metrics server failed to start', { message: (error as Error).message });
        reject(error);
      });

      this.server?.listen(this.port, this.host, () => {
        this.logger?.info('Prometheus metrics exporter listening', {
          host: this.host,
          port: this.port,
          path: this.path,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          this.logger?.warn('Error while shutting down metrics server', { message: error.message });
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = null;
  }

  observeLatency(metric: LatencyMetricName, valueMs: number): void {
    const valueSeconds = Math.max(0, valueMs) / 1000;

    switch (metric) {
      case 'wake_to_capture_ms':
        this.wakeToCapture.observe(valueSeconds);
        break;
      case 'capture_to_first_audio_ms':
        this.captureToFirstAudio.observe(valueSeconds);
        break;
      case 'wake_to_first_audio_ms':
        this.wakeToFirstAudio.observe(valueSeconds);
        break;
    }
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
