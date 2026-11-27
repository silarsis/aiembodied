# Local motion service API

A small HTTP service that keeps a text-to-motion model (NVIDIA ARDY or Kimodo)
loaded and returns animations retargeted to VRM humanoid bones. The Electron
main process talks to it through `LocalMotionClient`
(`app/main/src/avatar/motion/`).

- Default address: `http://127.0.0.1:8190` (the app reads `MOTION_SERVICE_URL`).
- CORS: pages served from `http://localhost:<port>` or `http://127.0.0.1:<port>` may call the service from the
  browser (the sit lab's Vite page does). Other origins get no CORS headers.
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
- `seed`: optional non-negative integer. The backend calls `torch.manual_seed(seed)` before generating this
  request, which replaces the process-wide `--seed` for it (the same request and seed give the same motion on
  the same device). Without it the process-wide seed is used if one was given, else generation is unseeded.
  Accepted by `/clip` and `/stream`.
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

Request: same fields as `/clip`, but `duration` is the total length (0.5 to 30,
default 4), plus these optional steering fields (ARDY backend only; the fake backend
follows root targets crudely, Kimodo ignores them). A request without them behaves as before.

```jsonc
{
  "prompt": "a person walks calmly",
  "duration": 6.0,
  "avatar_rest": { ... },          // hips[1] gives the avatar's hip height (scales all metres below)
  "phases": [                      // later prompts; takes effect at the first chunk starting at or after start_s
    {"prompt": "a person turns around and sits down on a chair", "start_s": 4.0}
  ],
  "path": {                        // pelvis path on the floor, motion frame, avatar metres
    "points": [[0, 0], [0, 2.5], [1.2, 3.0]],
    "corner_radius": 0.6,          // default 0.6
    "speed": 1.0,                  // m/s along the smoothed path, default 1.0
    "start_s": 0.3,                // when walking starts, default 0.3
    "mode": "dense"                // "dense" (every frame, corners rounded) | "waypoints" (the points only, not rounded)
  },
  "targets": [                     // timed keyframes, motion frame, avatar metres, heading in radians
    {"t": 5.5, "until": 7.0, "root": [0.0, 2.65], "height": 0.50, "heading": 3.1416, "reveal_s": 4.0},
    {"t": 2.0, "until": 2.3, "hand": "right", "position": [-0.18, 0.75, 0.50], "root": [0, 0], "height": 0.90, "heading": 0},
    {"t": 6.5, "until": 7.0, "joint": "left_knee", "position": [0.1, 0.52, 0.30], "reveal_s": 4.0}
  ],
  "constraint_weight": 2.0,        // default 2.0 (the constraint-only CFG pass; 1.0 helps on sharp paths)
  "continue_from": "s-1a2b",       // start from the end of an earlier stream, same motion frame
  "observed": {"joints": {"left_knee": [0.1, 0.5, 0.3]}, "root": [0.0, 0.2], "height": 0.5},  // with continue_from
  "snap_s": 0.3                    // blend the root onto exact root targets that hold (until > t) over this window before each target; 0 = off
}
```

Frames and units:
- The **motion frame** is where the stream starts: origin (0, 0) on the floor under the hips, facing +Z, Y up,
  in the avatar's metres (the service divides by `avatar_rest.hips[1] / 0.989` for the model and multiplies
  its output back; without `avatar_rest` the scale is 1). Heading theta means facing (sin theta, 0, cos theta),
  i.e. theta = atan2(dx, dz). With `continue_from` the motion frame is the same frame as the earlier stream.
- `height` is the pelvis (hips joint) height above the floor.
- `hand` targets (`"left"` or `"right"`) are wrist positions. The service expands one into the demo's
  end-effector bundle (wrist and middle-fingertip positions, palm-down wrist rotation, pelvis x/z/height and
  heading), so `root`, `height` and `heading` are required: they are the pelvis values to hold.
- `joint` targets (`left_knee`, `right_knee`, `left_ankle`, `right_ankle`) pin one joint to `position`
  ([x, y, z], motion frame, avatar metres; same scaling and `t`/`until`/`reveal_s` rules as the others). They map
  to the SOMA joints LeftShin / RightShin (SOMA's "Leg" is the thigh, so the knee is where the shin starts) and
  LeftFoot / RightFoot. ARDY only accepts a joint position on a frame whose pelvis x/z is constrained too, so
  give the target its own `root`, or let a root target overlap it; a joint target on any other frame is dropped.
  Use them to plan the legs round furniture, for example knees over the front edge of a seat. A target takes
  `hand` or `joint`, not both. The fake backend and Kimodo ignore them.
- `observed` (only with `continue_from`, otherwise 400) says where the body actually is now: `joints` (same names
  as joint targets), `root` [x, z] and `height`, in the motion frame and avatar metres. They become hard targets
  on the first 4 frames (0 to 3) of the continued stream and override any other target there. This is not a
  rewrite of the history: the model still remembers its own end pose and the observed pose only pulls the first
  frames onto the real one (a true rewrite would need inverse retargeting). Joints still need `root` (observed
  or a target) on those frames.
- `t`/`until`: the target holds on every frame from `t` to `until` inclusive (30 fps); `until` defaults to `t`.
  A target with a `root` that holds for more than one frame (`until` later than `t`) is also snapped onto exactly
  (x/z only) in the decoded motion, which moves the whole body with it. Single-frame targets and path
  waypoints are steered towards but not snapped: pulling the root onto points the feet are not planted for
  doubled foot sliding.
- `reveal_s`: the model only sees the target in chunks starting at or after this time (default 0). Reveal an
  action's targets when its phase starts, or the model squats on the walk to a chair that it can already see.
- **Round corners**: in `dense` mode the service rounds path corners with arcs of `corner_radius` (clamped to
  half of the shorter adjacent segment); sharp corners and 180 degree reversals make the gait shuffle, so plan
  turns on the spot as their own phase instead of as path vertices.

History is now 2 s (60 frames) for every request (it was up to 8 s), which leaves the window room for future
targets; a waypoint more than 2 s ahead was invisible with the old 240 frames.

Lines:

```json
{"type": "chunk", "index": 0, "start": 0.0, "vrma": { "meta": { "name": "wave-hello-0" } }, "timings": { "totalMs": 750 },
 "end_pose": { "root": [0.0, 0.62], "height": 0.97, "heading": 0.0, "left_hand": [0.2, 0.9, 0.1], "right_hand": [-0.2, 0.9, 0.1] }}
{"type": "chunk", "index": 1, "start": 2.0, "vrma": { "meta": { "name": "wave-hello-1" } }, "timings": { "totalMs": 360 }, "end_pose": { "...": "..." }}
{"type": "done", "chunks": 2, "timings": { "totalMs": 1110 }, "session": "s-1a2b3c"}
```

- Each chunk's keyframes start at `t = 0`; `start` is its offset in the full
  motion. Chunks are continuous: playing them back to back gives seamless motion.
- `end_pose` is the last frame of the chunk (after snapping): pelvis `root` x/z relative to the stream's
  origin, `height` above the floor, `heading`, and both wrists as [x, y, z], in the motion frame and avatar metres.
- The VRMA hips position track keeps its meaning: offset from the stream's motion-frame origin, in
  rest-hips-height units. With `continue_from` it continues from the earlier stream's origin, not from 0.
- `session` in `done` is an id usable as `continue_from` (kept in memory for 10 minutes, the last 8 only).
  It is absent for backends that cannot continue (Kimodo). A stream that ends part way through a 2 s chunk is
  continued from the last whole 4-frame group it played; the continued stream's first chunk leaves out the (up to
  3) frames the earlier stream had already sent, so its first hips position is the step after the last frame
  played, `start` times of later chunks count only frames actually sent, and the keyframe times still start at 0.
- The Kimodo backend sends the whole clip as a single chunk.
- A failure mid-stream is sent as `{"type": "error", "message": "..."}` and ends
  the stream.

## Errors

Non-2xx responses carry `{ "error": "message" }`: 400 for an invalid request (including a bad hand name,
non-finite numbers, an unknown joint, `observed` without `continue_from` or a target without what it needs), 404 `{"error": "unknown session"}` for a
`continue_from` that is unknown or expired, 503 when the model is not ready, 500 otherwise.
