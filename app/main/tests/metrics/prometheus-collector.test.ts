import { describe, expect, it } from 'vitest';
import { PrometheusCollector } from '../../src/metrics/prometheus-collector.js';

describe('PrometheusCollector', () => {
  it('records latency observations and exposes histogram metrics', async () => {
    const collector = new PrometheusCollector({ host: '127.0.0.1', port: 0 });

    collector.observeLatency('wake_to_capture_ms', 250);
    collector.observeLatency('capture_to_first_audio_ms', 500);
    collector.observeLatency('wake_to_first_audio_ms', 750);

    const metrics = await collector.metrics();

    expect(metrics).toContain('aiembodied_wake_to_capture_seconds_count 1');
    expect(metrics).toContain('aiembodied_capture_to_first_audio_seconds_count 1');
    expect(metrics).toContain('aiembodied_wake_to_first_audio_seconds_count 1');
  });

  it('starts and stops an HTTP server when requested', async () => {
    const collector = new PrometheusCollector({ host: '127.0.0.1', port: 0 });

    await collector.start();
    await collector.stop();
  });
});
