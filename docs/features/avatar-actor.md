# AvatarActor: per-avatar state split from the VRM scene

Phase 3 step 3a. A behaviour-preserving refactor of `app/renderer/src/avatar/vrm-avatar-renderer.tsx`
(about 2180 lines) so that step 3b can put several avatars in one scene. Nothing observable changes:
one actor (`echo`) is created and driven exactly as the component's refs were.

## Files

| File | Role |
| --- | --- |
| `avatar/avatar-actor.ts` | `AvatarActor`, a plain TS class (no React). Owns one avatar's state. |
| `avatar/vrm-avatar-helpers.ts` | The pure helpers that used to sit in the component file (pose, viseme, transition, VRMA loading, scene fitting). Moved verbatim and re-exported from `vrm-avatar-renderer.tsx`, so test and `pose-snapshot-generator.ts` imports are unchanged. They moved (rather than staying in the `.tsx`) because the actor needs them and the component imports the actor; leaving them would make a circular import. |
| `avatar/vrm-avatar-renderer.tsx` | `VrmAvatarRenderer`: the per-scene owner. Props and behaviour unchanged. |
| `avatar/animation-bus.tsx` | Requests and events gain an optional `avatarId`. |

## Per-avatar (in `AvatarActor`)

- Loaded VRM and its normalised scene graph (scale, floor offset, outlier-mesh suppression, base neutral pose).
- `AnimationMixer`, the VRMA clip registry (library clips and one-off streamed clips), the clip queue, the
  active animation (play, pose, held), handed-over clips, the idle suspension handle.
- Pose transitions (`transitionToPose`), the greeting wave action.
- Expression state: smoothed viseme weights, blink state, the latest `VisemeFrame`, emotion via `setEmotion`.
- `IdleAnimationScheduler` and the idle options it is built from.
- `PoseBlend` (eases limbs out of a motion) and the `JumpDetector` diagnostic (it tracks this body).
- Rest-skeleton measurement at load (`getRestSkeleton()`).
- Animation-bus consumer: `handleAnimationEvent(event)` handles an event only when `accepts(event)`.

## Per-scene (stays in `VrmAvatarRenderer`)

WebGL renderer, scene, camera, lights, canvas size, the `THREE.Timer` and `requestAnimationFrame` loop,
camera fitting (`onBounds` hook), the `RoomSceneController` and everything room-shaped (`setRoom`,
avatar height, navmesh debug, `SceneActionExecutor.setEnv`), the ground-foot measurement
(`renderedFootFraction` reads the whole canvas), model fetch over IPC, status reporting, behaviour-cue
subscription, and the `Map<avatarId, AvatarActor>` (one entry, `echo`).

## API

- `new AvatarActor({ id = 'echo', hasRoom })`
- `load({ binary, modelId, parent, isCancelled, onBounds, onAttached })`, `unload({ parent, onDetach })`, `dispose()` (idempotent; the actor can load again afterwards).
- `update(dt, now, { afterMixer })`: viseme/blink, mixer, `afterMixer` hook, VRMA expression keyframes, idle, pose blend, `vrm.update`. The room controller's `step` runs in the hook, between the mixer and the rest, as before.
- `checkJump(roomActive)` after the scene renders.
- `setVisemeFrame`, `setIdleOptions` / `applyIdleOptions`, `setEmotion`, `placeAt(x, z, facing)`, `getObject3D()`, `getVrm()`, `getRestSkeleton()`.
- `playClip(request)`, `playPose(request)`, `transitionToPose(pose, opts)`, `signalResponse()`, `playWave()`, `cancelAnimations()`, `reloadClipRegistry()`.

`load` takes hooks instead of returning intermediate values so the order of side effects is the old one: the camera is
fitted before the model enters the scene, and the room controller's `attachAvatar` runs right after `scene.add`, before
the mixer exists and before the (awaited) VRMA library loads.

### Animation bus routing

`AvatarAnimationRequest.avatarId`, and `avatarId` on the `applyPose` and `response` events (bus methods take it as an
optional last parameter). Missing means `echo`. The component hands every event to every actor and each actor takes only
its own, so `BehaviorCueProvider` and camera cues (which are not on this bus) are untouched.

## Deviations from the step 3a spec, and open items

- `setVisemeSource(analyser|stream)` is not there. In this renderer lip-sync arrives as `VisemeFrame`s from
  `audio/viseme-driver` through the `frame` prop; no analyser is attached in this file. The actor takes
  `setVisemeFrame(frame)`; step 3b adds per-avatar audio/analyser sources.
- `placeAt` is new and unused today (nothing placed avatars before; rooms use `RoomSceneController`). It offsets from the position the loader normalised to, so it is not valid for a body a room controller has moved.
- `playPose` is a `playClip` with intent `pose`; `transitionToPose` is the generated bone transition.

## Single-body assumptions that remain (step 4)

- `setAvatarRestSkeleton` / `getAvatarRestSkeleton` (`rest-skeleton.ts`) is one module-level slot that `App` reads for `{move:...}` streams. Every actor writes it; with two actors the last write wins.
- `RoomSceneController.attachAvatar` / `setAvatarHeight` and `SceneActionExecutor.setEnv` serve one body. The component attaches the single actor's scene and humanoid.
- `hasRoom` and `LIVE_MOTION_SOURCE` hip pinning apply per actor but the room prop is per component.
- `groundMeasured` / `onGroundPositionChange` measure the first rendered silhouette of the whole canvas.
- The camera framing (`fitCameraToBounds`) frames one model.
- The idle director and scene actions talk to the room, not to an actor id.

## Not verifiable here

None of this ran under WebGL. The unit suites mock `three` and the VRM loaders (see `avatar-renderers.smoke.test.tsx`,
`vrm-animation-queue.test.tsx`, and the new `tests/avatar/avatar-actor.test.ts`). Check in the running app: model loads
and frames the camera, lip-sync, blink, idle sway, wave on a greeting, queued animations and poses, streamed `{move}`
clips, entering and leaving a room, swapping models, and the ground-anchor callback.
