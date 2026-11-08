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

Body: `{ "text": "Hello.", "voice": "bf_lily", "speed": 1.0, "engine": "kokoro", "model": null }`
(all but `text` optional; `speed` 0.5–2.0; `text` up to 2000 characters).

- `engine`: `kokoro` (default, the engine the service started with), `kitten` or `piper`.
- Kitten: `model` is `mini-0.8` (default) or `nano-0.8`; `voice` one of Rosie, Bella, Luna,
  Kiki, Jasper, Bruno, Hugo, Leo (default Rosie).
- Piper: `voice` is the Piper voice, e.g. `en_GB-alba-medium` (each voice is its own model).

A Kitten model or Piper voice that isn't downloaded answers 409; an unknown voice 400.

Returns `audio/wav` (16-bit PCM mono; 24 kHz for Kokoro and Kitten, 22.05 kHz for most Piper
voices) with headers `X-Audio-Ms` and `X-Synthesize-Ms`.

## `GET /v1/tts/engines`

`{ "engines": [ { "id", "label", "available", "error", "models": [ { "id", "label", "installed",
"size_mb"?, "voices", "default_voice", "download" } ] } ] }`. `available` is false when the
engine's Python package is missing (`error` says why). `download` is null, or
`{ "status": "downloading" | "done" | "error", "received", "total", "error" }`.

## `POST /v1/tts/download`

Body: `{ "engine": "kitten", "model": "mini-0.8" }` or `{ "engine": "piper", "model":
"en_GB-alba-medium" }`. Starts the download in the background (202); progress shows in
`/v1/tts/engines`. Files come from Hugging Face (`KittenML/kitten-tts-*`,
`rhasspy/piper-voices`, using `HF_TOKEN` when set) into `TTS_MODELS_DIR` (default
`~/.cache/aiembodied/tts-models`). A partial download resumes.
