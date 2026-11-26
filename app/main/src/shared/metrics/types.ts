// Types only: shared/ holds what the main process and the renderer both need.

export type LatencyMetricName =
  | 'wake_to_capture_ms'
  | 'capture_to_first_audio_ms'
  | 'wake_to_first_audio_ms';
