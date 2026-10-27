# Local speech service

Speech-to-text and text-to-speech for the app's local conversation backend
(`CONVERSATION_BACKEND=local`, the default). The app records each utterance, sends it here for
transcription, gets a reply from the local LLM (llama-server, see `scripts/start-local-llm.ps1` at
the repo root), and sends the reply back here one sentence at a time to be spoken.

- **STT** (`--stt`, `STT_ENGINE`), one of:
  - `server` (default): any OpenAI-compatible chat endpoint that takes `input_audio`, set with
    `STT_URL` / `STT_MODEL` (default `http://127.0.0.1:1235/v1`, `qwen3-asr`), separate from the
    LLM's server. `scripts\start-local-asr.ps1` at the repo root runs
    [Qwen3-ASR-0.6B](https://huggingface.co/unslothai/Qwen3-ASR-0.6B-GGUF) on llama-server there:
    about 0.08–0.27 s per utterance on the Radeon 8060S, about 1 GB, and no measurable slowdown to
    Qwen Flash-Next running alongside it.
  - `whisper`: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) in this process,
    `small.en` by default: about 1 s per 4 s utterance on the Ryzen AI Max CPU. `large-v3-turbo`
    is more accurate but took about 4 s.
- **TTS:** [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) 82M through ONNX Runtime on the
  CPU, about 0.6 s per sentence. Default voice `bf_lily`; any Kokoro preset works
  (`bf_emma`, `bf_isabella`, `bm_george`, …). Every sentence uses one fixed style row
  (`--style-row 120`): Kokoro otherwise picks a style per text length, and speaking a reply one
  sentence at a time made the voice change part-way through. `bf_isabella`, `bf_emma`,
  `bm_fable` and `bm_george` hold their sound best on short text; `af_heart` and `af_bella` worst.
  The model files are the same ones slopcore uses
  (`kokoro-v1.0.onnx`, `voices-v1.0.bin`, from the kokoro-onnx GitHub releases).

The HTTP contract is in [API.md](API.md).

## Setup

```powershell
cd services\speech
uv venv .venv --python 3.13
uv pip install --python .venv\Scripts\python.exe -e ".[engines,test]"
```

With `-Stt whisper`, the first start downloads the Whisper model to the Hugging Face cache. The
default Qwen3-ASR server needs `unslothai/Qwen3-ASR-0.6B-GGUF` in the cache (model and `mmproj`).

## Run

```powershell
.\scripts\start.ps1 -KokoroDir C:\Users\kevin\repos\github\silarsis\slopcore\experiments\kokoro
..\..\scripts\start-local-asr.ps1     # Qwen3-ASR on :1235 (separate window)
.\scripts\start.ps1 -KokoroDir <dir> -Stt whisper -WhisperModel large-v3-turbo -Voice bf_emma
.\scripts\start.ps1 -Fake     # no models: a canned transcript and a tone, for wiring
```

The app finds the service through `SPEECH_SERVICE_URL` (default `http://127.0.0.1:8192`).

## Test

```powershell
.venv\Scripts\python -m pytest -q
```
