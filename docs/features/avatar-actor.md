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

## Step 3b: several avatars on the 2D stage

With two or more avatars in the registry (for example `AIEMBODIED_EXTRA_AVATARS=Sage`), the 2D stage shows them side
by side, each lip-syncs to its own voice, and animation tags drive only the speaker. With one avatar nothing changes:
App passes no `avatars` prop and the old `model`/`frame` path runs untouched.

- **Main.** Every `local-voice:event` and `local-voice:respond` result carries `avatarId` (echo included; stamped by
  `avatars/speaker.ts` `tagEvent`/`tagResult`). A floor-routed answer to "Sage, ..." therefore carries `sage`. The
  renderer treats a missing id as `echo`.
- **`LocalVoiceClient`.** One `MediaStreamAudioDestinationNode` per avatar in a lazily filled map. `echo` is created at
  connect and passed to `onRemoteStream` exactly as before; other avatars get a node on first use and
  `callbacks.onAvatarStream(avatarId, stream)`. A `Turn` takes its output when its first `sentence` event arrives. Events
  with request ids the client did not start (out-loud chatter, or a second avatar answering Kevin after the first) get a
  chatter `Turn` on the speaker's output (own map by request id, dropped when played). Chatter sets the activity to
  `responding` only if the client is idle and never touches the mic or `busy`. `stopChatter()` stops it; it is called
  when Kevin speaks (an admitted utterance, `talk()`), and on teardown. `onTextContent(sentence, avatarId?)`,
  `onFirstAudioFrame(avatarId?)` and `onAssistantTranscript(text, avatarId?)` pass the id only when it is not `echo`, so
  the echo callbacks are called with the same arguments as before.
- **App.** `onAvatarStream` creates a `VisemeDriver` plus a hidden `Audio` element per avatar (`avatarVoicesRef`),
  producing `visemeFrames`; they are disposed when the conversation goes idle/errors or the client is replaced. The
  avatar list is read from `avatars:list` (and `avatar.listModels` while there are 2+) at start, on window focus and every
  5 s while more than one avatar exists. `stageAvatars` maps each profile to its model (`vrmModelId`, else the active
  model; echo is always the active model). Tags in a non-echo reply go to the animation bus with that `avatarId`; `{move}`
  streams and scene actions are Echo-only for now (TODO step 4). Assistant lines are saved with `speaker` = avatar id
  (echo omits it, so the default `echo` applies), and the transcript shows the avatar's name.
- **`VrmAvatarRenderer`.** Optional `avatars?: { id, name?, model, frame }[]` (`VrmStageAvatar`). Echo keeps its
  existing effects; every other entry gets its own `AvatarActor` in the same `actors` map (so the frame loop and the
  animation bus see it), loaded from its model (a shared body is loaded once per actor). When 2+ bodies are loaded
  `layoutOffsets` places them side by side (symmetric about the centre, gap 15% of the widest), each on the same ground
  line via `placeAt`, the canvas becomes one portrait frame wide per avatar (max 3), and the camera is fitted to the
  union of the bounds (`data-avatar-count` on `.kiosk__avatar` widens the CSS box). Dropping back to one avatar re-fits
  Echo alone. Each actor gets its own `frame`. A name label sits under each avatar (`.stageAvatarLabel`); the one whose
  frame is open has `data-speaking="true"`.
- **Rooms.** TODO(step 4): rooms stay single-body. With `room` set only Echo is shown and the other actors are unloaded.
  The rest-skeleton slot (`setAvatarRestSkeleton`) is now written only by the `echo` actor, so extra actors no longer
  overwrite what `{move}` streams are calibrated for.

### Not verifiable here (3b)

Nothing ran under WebGL or real audio. Unit suites cover the client routing (fake `AudioContext`), the actor/layout
logic with mocked three, and App wiring with a fake client. Check in the running app with `AIEMBODIED_EXTRA_AVATARS=Sage`:
both avatars appear without overlapping and the feet sit on the ground line, each mouth moves only with its own voice,
Kevin saying "Sage, ..." plays on Sage's side, "Hear avatar chatter" chatter is audible from the right avatar and stops
when Kevin speaks, the name labels follow the avatars, the foot-anchor re-measures after the second avatar loads, and
entering a 3D room (and leaving it) restores a single centred Echo. Known limits: a chatter turn is forgotten once its
queued audio has played, so a long pause between its sentences restarts its activity bookkeeping; the output device
choice is not applied to extra avatars' audio (nor is it to Echo's element today).

## Managing avatars from the UI

Status and diagnostics has an **Avatars** panel (`app/renderer/src/status/avatar-manager.tsx`) next to "Hear avatar chatter". It lists every avatar and lets Kevin add one (name, optional body from the installed VRM models, optional prompt), rename it, change its body, edit its prompt (empty clears it) and remove it after a confirm. Echo has no Remove and follows the body chosen in the character settings.

Main process: `avatars:add`, `avatars:update`, `avatars:remove` (`app/main/src/main.ts`). The id is a slug of the name (`a-z0-9_-`), made unique with `-2`, `-3`. Names are at most 80 characters, prompts at most 4000. Adding starts the avatar's switchboard plumbing; removing stops its inbox and drops its voice service. The last avatar and Echo cannot be removed. The renderer re-reads the list right after each change. When a 3D room is active with 2+ avatars the panel notes that rooms show only Echo for now. `AIEMBODIED_EXTRA_AVATARS` still works as a dev shortcut.
