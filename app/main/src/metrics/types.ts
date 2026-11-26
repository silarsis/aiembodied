import type { LatencyMetricName } from '../shared/metrics/types.js';


export interface LatencyObservation {
  metric: LatencyMetricName;
  valueMs: number;
}
