# Speech service API

Base URL from `SPEECH_SERVICE_URL` (default `http://127.0.0.1:8192`). Errors are JSON `{"error": "..."}`
with a 4xx/5xx status. Both POST endpoints return 503 until `/health` reports `ready: true`.

## `GET /health`

```json
{
  "status": "ok",            // "loading" | "ok" | "error"
  "ready": true,
  "error": null,
  "stt": { "engine": "openai-compatible", "model": "qwen3-asr", "url": "http://127.0.0.1:1235/v1" },
  "tts": { "engine": "kokoro", "model": "…/kokoro-v1.0.onnx", "voices": ["af_heart", "…"], "default_voice": "bf_lily", "style_row": 120 }
}
```

## `POST /v1/stt`

Body: a 16-bit PCM WAV file (any sample rate or channel count; it is downmixed and resampled to
16 kHz mono). Limit 60 s.

```json
{ "text": "what's the weather like", "timings": { "audio_ms": 2100, "transcribe_ms": 610 } }
```

## `POST /v1/tts`

Body: `{ "text": "Hello.", "voice": "bf_lily", "speed": 1.0, "exaggeration": 0.7 }` (all but `text`
optional; `speed` 0.5–2.0, ignored by Chatterbox; `exaggeration` 0–2, Chatterbox's emotion dial,
ignored by Turbo and Kokoro; `text` up to 2000 characters).

With `--tts chatterbox`, `voices` lists Kokoro presets and Chatterbox reference voices together,
and `voice` picks the engine. `tts` in `/health` then also carries `variant`, `exaggeration`,
`fallback` (the Kokoro settings) and `chatterbox_error`.

Returns `audio/wav` (16-bit PCM mono, 24 kHz for Kokoro) with headers `X-Audio-Ms` and
`X-Synthesize-Ms`.
