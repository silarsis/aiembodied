import { PrometheusCollector } from './prometheus-collector.js';
import type { LatencyObservation } from './types.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface MetricsIpcOptions {
  handle: HandleIpc;
  metrics: PrometheusCollector | null;
}

export function registerMetricsIpc(options: MetricsIpcOptions): void {
  const { handle, metrics } = options;

  handle('metrics:observe-latency', (_event, payload: LatencyObservation) => {
    if (!metrics) {
      return false;
    }

    if (!payload || typeof payload.valueMs !== 'number') {
      throw new Error('Invalid latency observation payload received.');
    }

    metrics.observeLatency(payload.metric, payload.valueMs);
    return true;
  });
}
