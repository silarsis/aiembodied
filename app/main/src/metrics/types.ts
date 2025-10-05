export type LatencyMetricName =
  | 'wake_to_capture_ms'
  | 'capture_to_first_audio_ms'
  | 'wake_to_first_audio_ms';

export interface LatencyObservation {
  metric: LatencyMetricName;
  valueMs: number;
}
