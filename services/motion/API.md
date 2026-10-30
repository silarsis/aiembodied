# Local motion service API

A small HTTP service that keeps a text-to-motion model (NVIDIA ARDY or Kimodo)
loaded and returns animations retargeted to VRM humanoid bones. The Electron
main process talks to it through `LocalMotionClient`
(`app/main/src/avatar/motion/`).

- Default address: `http://127.0.0.1:8190` (the app reads `MOTION_SERVICE_URL`).
- One backend per process, chosen at startup (`--backend ardy|kimodo`), because
  the two models need different `transformers` versions and so live in
  separate venvs.
- All animation payloads use the app's VRMA JSON format, validated by
  `vrmaSchema` in `app/main/src/avatar/vrma-schema.ts`:
  `{ meta: {name, fps, loop, duration, kind}, tracks: [{bone, keyframes: [{t, q}]}], hips: {position?: {keyframes: [{t, p}]}}, expressions: [] }`.
  Bone names are VRM humanoid bone names (`hips`, `spine`, `leftUpperArm`, ...),
  quaternions are `[x, y, z, w]` local rotations in VRM 1.0 normalized space,
  and keyframe times are seconds from the start of that payload.

## `GET /health`

```json
{ "status": "ok", "backend": "ardy", "device": "cuda:0 AMD Radeon 8060S", "ready": true }
```

`ready` is false while weights are still loading; generation endpoints return
503 until it is true.

## `POST /v1/motion/clip`

Generate a whole clip and return it in one response.

Request:

```json
{ "prompt": "a person waves hello with their right hand", "duration": 3.0, "steps": 25, "name": "wave-hello" }
```

- `prompt` (required): free text.
- `duration`: seconds, 0.5 to 10, default 3.
- `steps`: diffusion steps; backend default when omitted.
- `name`: slug for `meta.name`; defaults to a slug of the prompt (max 40 chars).
- `avatar_rest` (optional): the avatar's rest skeleton, used to calibrate the arm swing to its
  build. An object mapping each of `hips`, `spine`, `chest`, `upperChest`, and `left`/`right` +
  `Shoulder`, `UpperArm`, `LowerArm`, `Hand` to `[x, y, z]`: normalized-bone positions in metres,
  Y up from the floor, facing +Z with the character's left on +X. A missing bone or a non-finite value is a 400.

Response 200:

```json
{ "vrma": { "meta": { "name": "wave-hello", "fps": 30, "loop": false, "duration": 3.0, "kind": "ardy" }, "tracks": [], "hips": {}, "expressions": [] },
  "timings": { "encodeMs": 150, "generateMs": 1700, "retargetMs": 50, "totalMs": 1910 } }
```

## `POST /v1/motion/stream`

Generate motion in chunks and stream each one as soon as it is ready
(`Content-Type: application/x-ndjson`, one JSON object per line).

Request: same fields as `/clip`, but `duration` is the total length (0.5 to 20,
default 4).

Lines:

```json
{"type": "chunk", "index": 0, "start": 0.0, "vrma": { "meta": { "name": "wave-hello-0" } }, "timings": { "totalMs": 750 }}
{"type": "chunk", "index": 1, "start": 2.0, "vrma": { "meta": { "name": "wave-hello-1" } }, "timings": { "totalMs": 360 }}
{"type": "done", "chunks": 2, "timings": { "totalMs": 1110 }}
```

- Each chunk's keyframes start at `t = 0`; `start` is its offset in the full
  motion. Chunks are continuous: playing them back to back gives seamless motion.
- The Kimodo backend sends the whole clip as a single chunk.
- A failure mid-stream is sent as `{"type": "error", "message": "..."}` and ends
  the stream.

## Errors

Non-2xx responses carry `{ "error": "message" }`: 400 for an invalid request,
503 when the model is not ready, 500 otherwise.
