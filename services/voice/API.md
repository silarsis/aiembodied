# Voice service HTTP API

Local speech-to-text and text-to-speech for the app's local voice chain. The app's main
process (`app/main/src/voice/voice-service-client.ts`) is the only client. Default address:
`http://127.0.0.1:8191`.

Errors are JSON `{"error": "..."}`: 400 for a bad request, 503 while the models are still
loading (or failed to load), 500 otherwise.

## `GET /health`

```json
{"status": "ok", "ready": true,
 "stt": {"backend": "faster-whisper", "device": "small.en on cpu (int8)"},
 "tts": {"backend": "kokoro", "device": "kokoro-v1.0 on cpu", "voice": "af_heart"}}
```

`status` is `"error"` (with an `error` field) when loading failed. `ready` is false while loading.

## `POST /v1/stt?sample_rate=16000`

Body: raw 16-bit little-endian mono PCM at 16 kHz (`application/octet-stream`), at most 60 s.

```json
{"text": "what's the weather like", "language": "en", "durationMs": 1840, "timings": {"sttMs": 310}}
```

Silence gives `"text": ""`.

## `POST /v1/tts`

Body: `{"text": "Hello there!", "voice": "af_heart", "speed": 1.0}`. `text` is 1-2000
characters; `voice` and `speed` (0.5-2.0) are optional.

Response: raw 16-bit little-endian mono PCM (`application/octet-stream`), with headers
`X-Sample-Rate` (24000 for Kokoro) and `X-Tts-Ms`.

## `GET /v1/voices`

`{"default": "af_heart", "voices": ["af_alloy", "af_heart", ...]}`
