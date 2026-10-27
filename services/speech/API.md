# Speech service API

Base URL from `SPEECH_SERVICE_URL` (default `http://127.0.0.1:8192`). Errors are JSON `{"error": "..."}`
with a 4xx/5xx status. Both POST endpoints return 503 until `/health` reports `ready: true`.

## `GET /health`

```json
{
  "status": "ok",            // "loading" | "ok" | "error"
  "ready": true,
  "error": null,
  "stt": { "engine": "faster-whisper", "model": "small.en", "device": "cpu" },
  "tts": { "engine": "kokoro", "model": "…/kokoro-v1.0.onnx", "voices": ["af_heart", "…"], "default_voice": "bm_george" }
}
```

## `POST /v1/stt`

Body: a 16-bit PCM WAV file (any sample rate or channel count; it is downmixed and resampled to
16 kHz mono). Limit 60 s.

```json
{ "text": "what's the weather like", "timings": { "audio_ms": 2100, "transcribe_ms": 610 } }
```

## `POST /v1/tts`

Body: `{ "text": "Hello.", "voice": "bm_george", "speed": 1.0 }` (`voice` and `speed` optional;
`speed` 0.5–2.0; `text` up to 2000 characters).

Returns `audio/wav` (16-bit PCM mono, 24 kHz for Kokoro) with headers `X-Audio-Ms` and
`X-Synthesize-Ms`.
