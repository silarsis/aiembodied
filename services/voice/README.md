# Local voice service

Speech-to-text ([faster-whisper](https://github.com/SYSTRAN/faster-whisper)) and text-to-speech
([Kokoro](https://github.com/thewh1teagle/kokoro-onnx)) over HTTP, for the app's local voice
chain. The conversation itself runs on a local LLM (Qwen Next Flash on llama-server, the same
setup slopcore uses); the app calls that directly. API: [API.md](API.md).

```
mic -> app (utterance detection) -> /v1/stt -> Qwen (streamed) -> /v1/tts per sentence -> speaker
```

Both models run on the CPU on purpose. On the Z13 the GPU's unified memory is taken by Qwen
(~92 GB) and the motion service, and both are faster than real time on the Ryzen cores.

## Run it (PowerShell, on bija)

```powershell
cd C:\Users\kevin\repos\github\silarsis\aiembodied\services\voice
.\scripts\start.ps1
```

The first run creates `.venv`, installs `.[local]`, downloads the Kokoro model files into
`models\` and (on first load) the whisper model from Hugging Face. Options: `-SttModel`
(`tiny.en`, `base.en`, `small.en` (default), `distil-large-v3`, ...), `-Voice` (any Kokoro
voice, e.g. `af_heart`, `af_bella`, `bf_emma`, `am_michael`), `-Port`.

For wiring checks without models: `.venv\Scripts\python -m voice_service --backend fake`.

## The LLM

Start llama-server with Qwen Next Flash on port 1234, as in slopcore's `services.llama`:

```powershell
llama-server.exe -m C:\path\to\qwen-next-flash.gguf --port 1234 -ngl 999 -c 65536 --jinja
```

The app sends `chat_template_kwargs: {enable_thinking: false}`, as slopcore does, so replies
start without a long reasoning preamble.

## Tests

```bash
python -m venv .venv && .venv/bin/pip install -e '.[test]' && .venv/bin/pytest
```
