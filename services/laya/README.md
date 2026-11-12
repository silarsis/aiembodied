# Laya (quick decisions)

[Laya](https://pypi.org/project/laya/) (Convai Innovations, Apache-2.0) is a small "System 1" model: it answers
a few typed questions about a short piece of text in one fast pass, with no text generation. The app uses it for
quick decisions where asking a chat model would be slow and heavy:

- who a line is aimed at (an avatar, Kevin, or everyone), so "lenha, what are you up to?" reaches Lenha;
- how much each avatar wants to reply, for the floor's bids;
- what to do with an incoming message (ignore, remember or say), and whether it is a good moment to speak unprompted.

See `docs/features/quick-decisions.md` for the API and when to use it.

This folder only installs and starts it. The app talks to its `/v1/systemone` API
(`app/main/src/decide/system-one.ts`) through the **Quick decisions** use in Models and servers. When that use is
off, or Laya is not answering, the checks use the Idle thoughts model (bids) or the older name rules (addressee).

## Run

```powershell
.\scripts\start.ps1             # http://127.0.0.1:8197
```

`pnpm dev:run` starts it for you while Quick decisions use it (turn off with `LAYA_ENABLED=0` or `LAYA_AUTOSTART=0`).
The first start installs `laya[serve]` into `.venv` and **downloads the checkpoint from Hugging Face**; the server
answers `/health` straight away and takes questions once the checkpoint has loaded.

Check it is working: `pnpm laya:check` from the repo root prints answers and timings for a few known situations.

## Settings

| Variable | Meaning | Default |
| --- | --- | --- |
| `LAYA_URL` | where the app finds it (also `-Port`) | `http://127.0.0.1:8197` |
| `LAYA_DEVICE` | `cpu` or `cuda` | `cpu` (a 512-token state is quick on a CPU, and it keeps the GPU free) |
| `LAYA_MODELS` | checkpoints to load at start: `english`, `multilingual`, `typed-decisions` | `english` |
| `LAYA_DEFAULT_MODEL` | checkpoint used when a request names none | `english` |
| `LAYA_VENV` | virtualenv folder | `services/laya/.venv` |
| `LAYA_API_KEY` | if set, requests need `Authorization: Bearer <it>`; add the same key to the server in the app | none |

The server binds `127.0.0.1` only. `LAYA_PRELOAD=1` is always set. To use another checkpoint, put its name in the
Quick decisions model field (it must be in `LAYA_MODELS`).

## API used

- `GET /health` -> `{"status": "ok", "loaded": ["english"], ...}`
- `POST /v1/systemone` with `{"model", "state", "questions"}`; each question is `choice` (criteria: option -> text),
  `score` (criteria: a list of levels, lowest first) or `noul` (yes/no). The answers come back by question key:
  `choice.probabilities`, `score.score` (expected level index), `noul.noul` (probability of yes).

The English checkpoint reads about 512 tokens, so the app sends only the last few clipped lines.
