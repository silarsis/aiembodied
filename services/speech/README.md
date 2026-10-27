# Local speech service

Speech-to-text and text-to-speech for the app's local conversation backend
(`CONVERSATION_BACKEND=local`, the default). The app records each utterance, sends it here for
transcription, gets a reply from the local LLM (llama-server, see `scripts/start-local-llm.ps1` at
the repo root), and sends the reply back here one sentence at a time to be spoken.

- **STT:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper). `small.en` by default:
  about 1 s per 4 s utterance on a Ryzen AI Max CPU. `large-v3-turbo` is more accurate but took
  about 4 s on the same machine.
- **TTS:** [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) 82M through ONNX Runtime on the
  CPU, about 0.6 s per sentence. Default voice `bm_george`; any Kokoro preset works
  (`af_heart`, `am_michael`, `bf_emma`, …). The model files are the same ones slopcore uses
  (`kokoro-v1.0.onnx`, `voices-v1.0.bin`, from the kokoro-onnx GitHub releases).

The HTTP contract is in [API.md](API.md).

## Setup

```powershell
cd services\speech
uv venv .venv --python 3.13
uv pip install --python .venv\Scripts\python.exe -e ".[engines,test]"
```

The first start downloads the Whisper model to the Hugging Face cache.

## Run

```powershell
.\scripts\start.ps1 -KokoroDir C:\Users\kevin\repos\github\silarsis\slopcore\experiments\kokoro
.\scripts\start.ps1 -KokoroDir <dir> -WhisperModel large-v3-turbo -Voice am_michael
.\scripts\start.ps1 -Fake     # no models: a canned transcript and a tone, for wiring
```

The app finds the service through `SPEECH_SERVICE_URL` (default `http://127.0.0.1:8192`).

## Test

```powershell
.venv\Scripts\python -m pytest -q
```
