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

- **Expressive TTS** (`--tts chatterbox`, `TTS_ENGINE=chatterbox`): [Chatterbox](https://github.com/resemble-ai/chatterbox)
  through ONNX Runtime on the CPU, so no PyTorch (PyTorch on ROCm is unreliable on the Radeon
  8060S). It clones a voice from a reference clip in [`voices/`](voices/README.md), so the accent
  comes from the clip; the start script makes `voices\isabella.wav` from Kokoro's `bf_isabella` the
  first time. Kokoro stays loaded: its presets still work by name, and if Chatterbox fails to load
  the service speaks with Kokoro's `--voice` instead (`/health` shows `kokoro (chatterbox failed)`).
  Two models, set with `CHATTERBOX_MODEL`:
  - `onnx-community/chatterbox-ONNX` (default, 0.5B): an emotion dial, `CHATTERBOX_EXAGGERATION`
    (0.5 neutral, 0.7+ animated, default 0.6), also settable per request.
  - `ResembleAI/chatterbox-turbo-ONNX` (350M, faster): no dial, but it performs tags such as
    `[laugh]`, `[chuckle]` and `[sigh]` in the text. Kokoro drops such tags rather than reading them.

  Other settings: `CHATTERBOX_DTYPE` (`fp32`, `fp16`, `q8`, `q4`, `q4f16`), `CHATTERBOX_PROVIDERS`
  (`cpu`, or `dml,cpu` with onnxruntime-directml installed), `CHATTERBOX_THREADS`,
  `CHATTERBOX_VOICE` (default `isabella`), `CHATTERBOX_VOICES` (folder). The first start downloads
  the model from Hugging Face (about 2 GB at fp32).

The HTTP contract is in [API.md](API.md).

## Setup

```powershell
cd services\speech
uv venv .venv --python 3.13
uv pip install --python .venv\Scripts\python.exe -e ".[engines,test]"
# for TTS_ENGINE=chatterbox:
uv pip install --python .venv\Scripts\python.exe -e ".[engines,chatterbox,test]"
```

With `-Stt whisper`, the first start downloads the Whisper model to the Hugging Face cache. The
default Qwen3-ASR server needs `unslothai/Qwen3-ASR-0.6B-GGUF` in the cache (model and `mmproj`).

## Run

```powershell
.\scripts\start.ps1 -KokoroDir C:\Users\kevin\repos\github\silarsis\slopcore\experiments\kokoro
..\..\scripts\start-local-asr.ps1     # Qwen3-ASR on :1235 (separate window)
.\scripts\start.ps1 -KokoroDir <dir> -Stt whisper -WhisperModel large-v3-turbo -Voice bf_emma
.\scripts\start.ps1 -KokoroDir <dir> -Tts chatterbox   # expressive voice from voices\isabella.wav
.\scripts\start.ps1 -Fake     # no models: a canned transcript and a tone, for wiring
```

The app finds the service through `SPEECH_SERVICE_URL` (default `http://127.0.0.1:8192`).

## Test

```powershell
.venv\Scripts\python -m pytest -q
```
