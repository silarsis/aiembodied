# Chatterbox reference voices

Each `<name>.wav` here is a Chatterbox voice called `<name>` (`--chatterbox-voice`, `CHATTERBOX_VOICE`).
Chatterbox copies the speaker, accent and delivery of the clip, so use 10–15 s of one person speaking
clearly with some feeling, no music or noise. Only the first 10 s are used.

To start from a Kokoro preset (British for `bf_*`):

```powershell
.venv\Scripts\python -m speech_service.make_voice --kokoro-dir $env:KOKORO_DIR --voice bf_isabella --out voices\isabella.wav
```

The clips are ignored by git; keep your own copies.
