# 3D rooms

**Status:** Step 2 shipped (scene runtime and selector). Step 3 (walking, sitting, looking and picking things up) and step 3b (idle wandering) are implemented in the app and in `services/motion`. Neither step has been run end to end on a real display with the ARDY model at merge time: the room renderer was checked with a software WebGL screenshot, and the physics, navigation, planner and executor with unit tests. The grip pose and the hand-held object look are unchecked by eye.

Controls → Backgrounds now has two tabs, **2D pictures** and **3D rooms**. Picking a room puts the avatar inside it: the room is loaded into the avatar's three.js scene with physics colliders, a navigation mesh and a fixed camera. The 2D picture and its ground shadow are hidden while a room is active. The Backgrounds item in the drawer shows the room's name.

## What exists

- Two built-in rooms, both made only of boxes, cylinders and spheres: **Reading room** (sofa, armchair, coffee table, bookshelf, floor lamp, side table, rug, a mug) and **Studio flat** (desk and chair, bed, kitchen counter, bedside table, plant, rug, a mug). Each is about 6 m by 5 m by 2.8 m with a window on the north wall and a door on the east wall.
- The avatar stands at the room's home spot, about 2.4 m in front of the camera, facing it. The canvas fills the stage instead of the fixed 480 by 640 pixels, so the same room works on a portrait or a landscape window.
- Dynamic props (the mug) are rigid bodies and settle on the table. The avatar is a kinematic capsule that follows the avatar's position and can push them.
- Choosing another room, or going back to a picture or the plain background, disposes the old room, puts the avatar back at the origin facing forward, restores the 2D camera and cancels any live motion clip and queued animations.
- On a 2D picture the hips' horizontal travel is removed from live `{move:...}` clips so the avatar stays on its spot (the height is kept). In a room the travel is kept, and the scene actions below turn it into real root motion.
- With the metrics HUD flag on, the 3D tab has a **Show walkable area** checkbox that draws the navigation mesh over the room.
- Describing a room to build it is not part of this step. The 3D tab says so.

## Scene format

Rooms are JSON files (`RoomFile` in `app/main/src/rooms/types.ts`, checked by `validateRoomFile` in `validate.ts`). Built-in rooms live in `app/main/assets/rooms/<name>.json` and have the id `room:builtin:<name>`. Saved rooms live in `<userData>/rooms/<uuid>/room.json` with the id `room:<uuid>`; a saved file that fails validation is skipped with a console warning. The active room is stored under the same `stage.activeBackground` key as pictures; any id starting with `room:` must exist.

- `shell`: floor-centred box (`width` along x, `depth` along z, `height`), colours, optional ceiling, `openings` (windows and doors with `wall`, `offset` from the wall's centre along +x or +z, `width`, `height`, `sill`) and an `outside` colour seen through windows. Walls are 0.1 m thick, built around the openings.
- `objects`: `id` (unique slug), `name`, `position` (y is the floor contact), `rotationY`, `size` (bounding box used for colliders and navigation obstacles), `parts` (primitive geometry relative to the object origin), `collider` (`box` by default, `none` for the rugs), `dynamic`, and `tags`. A `model.file` field is reserved for GLB models in a later step; it is validated but never fetched yet.
- Tags (`sit`, `stand`, `grab`, `look`, `surface`, `idle`) are in object-local space and rotate with the object. `worldTag(room, objectId, kind)` in `app/renderer/src/rooms/room-tags.ts` converts them to world positions and facings.
- `lights`, a `camera` (position, target, vertical fov) and the `home` pose.

Conventions: metres, Y up. The avatar faces +Z at facing 0 and the camera sits on +Z looking back at it. A facing of theta degrees points along (sin theta, 0, cos theta).

## Code map

Main process: `app/main/src/rooms/` (`types.ts`, `validate.ts`, `room-service.ts`). `BackgroundService` takes the room service through its `rooms` option. IPC channels are `background:list-rooms` and `background:load-room`, exposed as `backgrounds.listRooms()` and `backgrounds.loadRoom(id)`.

Renderer: `app/renderer/src/rooms/`.

| File | Job |
|---|---|
| `room-builder.ts` | Turns a `RoomFile` into a three.js group; `dispose()` frees it. Has a `loadModel` hook for later. |
| `room-geometry.ts` | Wall pieces around openings, shared by the builder and physics. |
| `room-physics.ts` | Rapier world: static colliders, dynamic props, avatar capsule (radius 0.25, height 1.6). |
| `room-navmesh.ts` | Recast navmesh (agent radius 0.3, height 1.7, max climb 0.15): `findPath`, `closestWalkable`, `isWalkable`, `debugMesh`. |
| `room-stage.ts` | `RoomStage` ties these together without touching WebGL, so it runs in tests. If either WASM library fails to start the room still renders. |
| `room-scene-controller.ts` | Switches the avatar renderer between 2D and room mode (canvas size, camera, avatar placement). Owns the `sceneEnv`. |
| `scene-frames.ts` | World to motion frame maths and the root bake. |
| `scene-actions.ts` | Tag object matching and the planner: scene action to motion stream request. Pure. |
| `scene-executor.ts` | The action queue, stream tracking, events, bake and state. Runs against `SceneEnv` and `SceneBridge` interfaces. |
| `scene-env.ts` | The real `SceneEnv`: avatar root pose, hand attach, grip, placing props. |
| `grip-pose.ts` | Curls the finger bones of a hand around a held object. |
| `scene-instructions.ts` | The room description and tag syntax added to the model's instructions. |
| `room-thumbnail.ts` | Renders the selector's card images, or nothing where WebGL is missing. |

The navmesh is built from the floor with every non-dynamic collider's footprint cut out, so furniture is never walkable on top. Paths therefore keep about 0.3 m from furniture and walls, and a target inside furniture (such as a sit position) snaps to the nearest floor beside it.

## Scene actions (step 3)

In a room, while the local motion service is ready, the assistant can walk to things, look at them, sit, stand, pick things up and put them down. It writes tags in its reply, next to any `{move:...}` tags:

| Tag | What happens |
|---|---|
| `{go:X}` | Walk to X's `stand` tag, or the closest walkable point in front of X's face (the side facing the room centre), and face X. |
| `{come}` | Walk back to the room's `home` spot and face its facing. |
| `{look:X}` | Turn on the spot to X's `look` tag (or the middle of X). Skipped if already within 20 degrees. |
| `{sit:X}` | X needs a `sit` tag. Walk to the point 0.45 m in front of the seat, turn around and sit. |
| `{stand}` | Stand up from the seat. Does nothing when already standing. |
| `{pick:X}` | X needs a `grab` tag and must be dynamic. Go near it if more than 0.7 m away, reach with the nearer hand, take it. |
| `{put:X@S}` (or `{put:X on S}`) | Needs to be holding X and S needs a `surface` tag. Go near S if needed, reach to the top of S, put X down. |

Object names match a room object's id or name, ignoring case, articles ("the") and a simple plural. A bare noun such as "table" works when exactly one object name ends with it. Unknown objects, missing tags, no path, or a room without navigation skip the action with a `console.warn` and the queue carries on. The tags are stripped from speech and from the transcript like `{move:}`; `{stand}` and `{come}` are reserved, so an animation with either slug cannot be played by the plain `{slug}` form (use `{anim:stand}`).

**What the model is told.** `buildSceneInstructions` (`rooms/scene-instructions.ts`) adds the room name, its objects with what each allows (sit; go to / look at; pick up; put things on) and the tag syntax to the animation instructions, only when a room is active and live motion is ready. In 2D the text is unchanged. It is part of `sessionInstructions` in `App.tsx`, which both the local voice path and OpenAI Realtime use, so a room change refreshes it through the usual session update.

### How an action is planned and run

- Actions run **one at a time** from a queue (`SceneActionExecutor`, `rooms/scene-executor.ts`). `{move:}` gestures that arrive meanwhile wait in the same queue, and are skipped while seated.
- Each action becomes **one** `POST /v1/motion/stream` (see `services/motion/API.md`), built by `planAction` in `rooms/scene-actions.ts` from the room, the navmesh and the avatar's state. Getting ready is done by inserting actions: a walk, look, pick or put while seated first plays a stand; a pick or put that is too far first goes near.
- **Walking:** the navmesh path becomes a dense `path` (corners rounded 0.6 m, 1 m/s, start 0.3 s) with the prompt "a person walks calmly". Heading is left off along the path; one heading target at arrival plus 0.5 s faces the object. Duration is arrival plus 1.5 s.
- **Sitting:** a walk phase, then a second prompt ("a person turns around and sits down on a chair") from the next 2 s chunk boundary after arrival (`phases`). The sit target (root, hip height = seat height plus 0.08 m, heading) is only revealed from that boundary (`reveal_s`). The session id the service returns is kept; **standing up** continues from it (`continue_from`) in the same motion frame.
- **Reaching:** prompt "a person reaches out and picks something up from a table", a hand target (the demo's end-effector bundle is built by the service) at 1.5 to 1.8 s with the pelvis held. At 1.7 s the object is attached to the hand bone (it keeps its world transform and then follows the hand), its physics body goes kinematic, and the fingers curl (`rooms/grip-pose.ts`). A put detaches it at 1.7 s, sets it on the top of the surface at the hand's position (clamped 0.15 m inside the edge), makes it dynamic again and opens the hand.
- **Frames** (`rooms/scene-frames.ts`): a fresh stream's origin is the avatar's root (the VRM scene's x/z and yaw). World points are translated, rotated by minus the yaw and **divided by the avatar's scale** (the scene scale, so world metres become the avatar's own metres, which is what the service expects). The hips tracks of the chunks are then already in the avatar's local frame, which is how the hips node moves under the VRM scene, so nothing is converted per frame.
- **Root bake:** when the last chunk of a standing-ended stream has finished playing, the scene root is moved to the last chunk's `end_pose` (converted back to the world) and turned to its heading, and the clip is dropped in the same frame so the idle pose takes over at the local origin. Chunks end in an `onEnd` callback that answers `release` for this; the planned end is the fallback when the service reports no `end_pose`.

- **Motion service details** (`services/motion/API.md`): the root is snapped only onto root targets that hold for more than one frame (`until` later than `t`), never onto single-frame waypoints or turn points, which doubled foot sliding in the sit test (6.2 to 11.7 cm/s). A `continue_from` stream whose parent ended mid-chunk leaves out the (up to 3) frames the parent had already sent, so a walk does not rewind by about 9 cm and the hips track stays continuous.

### Avatar states

`standing` (free), `seated` (on object X, with the stream session and the motion-frame origin kept) and, combinable with standing or seated, `holding` (object Y in a hand). While seated the last frame of the sit clip is held (`onEnd` answers `hold`), idle motion stays suspended, and a pose tag, an animation tag or a gesture is ignored so nothing stands the avatar up; only the stand-up continuation replaces the pose. Breathing is therefore off while seated; blinking and speech stay.

### Interruptions

- The user starts talking (the microphone gate opens while the avatar is not speaking), a wake word, or a tap or push-to-talk: the queue is dropped and a walk or turn in progress is stopped where it is (the stream is cancelled over `avatar-motion:cancel`, further chunks are ignored, and the root is baked at the end of the last chunk already queued). Sitting, standing, picking up and putting down finish. A seated avatar stays seated.
- A room change (or leaving the room, or a new avatar model) cancels everything, puts a held object back where it was picked up, and resets the state.

### Limits

- The physics capsule follows the hips, so a walking avatar pushes the mug; a held object is kinematic and is ignored by it.
- A prop that is more than about 0.6 m from the nearest walkable point cannot be reached; the reach just ends with the hand short and the object snapping to the hand when attached.
- The motion origin is taken to be the VRM scene origin. A model whose hips sit far from it is offset by that distance.
- The avatar holds one object at a time.
- Paths, targets and phases need the ARDY backend of the motion service; the fake backend only moves the root crudely and Kimodo ignores them.

## Idle wandering (step 3b)

When nobody has talked for a while, the avatar in a 3D room does things on its own: walks to the bookshelf and browses, sits in the armchair, picks up a mug. It only goes to things the fixed camera can see, only in a 3D room, only while the local motion service is ready, and talking always wins.

**Settings.** Controls → Backgrounds → 3D rooms → **When idle** (saved as `rooms.idle` in the memory store, read and written through `backgrounds.getIdleSettings` / `setIdleSettings`):

- *Wander when nobody is talking*, on by default.
- *Restlessness*: Calm, Normal (default) or Restless, a mean wait between idle actions of 180, 90 or 40 seconds. Each wait is drawn uniformly from 60 % to 140 % of the mean.
- *When I start talking*: **Turn to me where it is** (default) or **Come back to me**.

**Idle habits.** Controls → Character has an *Idle habits* text (at most 500 characters) under the personality prompt, kept per avatar (`avatar:idle-habits:get` / `:set`, stored under `avatar.idleHabits.<model id>` like the personality prompt). It goes into the idle prompt, e.g. "sits by the window with tea; tidies when bored".

**When it acts** (`rooms/idle-director.ts`). The avatar counts as idle when there is no user speech, wake word, tap or push-to-talk, the assistant is not transcribing, thinking or responding, and no scene action is queued or running. The first idle action comes 45 s after the last activity; each later one after the restlessness interval, counted from the end of the previous idle action. Any conversation activity throws away a decision still being made and goes back to the 45 s rule.

**What it does.** The director asks the **Idle thoughts** model (a Models and servers job, see [Models and servers](models-and-servers.md)) for 1 to 3 action tags. The prompt (`rooms/idle-prompt.ts`) gives the character's name and the first 300 characters of the personality, the idle habits, the room, the objects the camera can see with what each allows and its `tags.idle` hint, the current state (standing near X, seated on Y, holding Z), the last five idle actions and the local time of day. The reply is read with the normal tag parser: at most 3 tags, only scene tags, `{move:...}` and `{wait}` (do nothing this time). Tags are dropped when the object does not exist, is not visible to the room camera, or lacks the tag the action needs. If nothing valid is left, or the model fails or times out (15 s), a weighted random picker takes over (`rooms/idle-actions.ts`): sit on seats, `{go:x}` with a `{move:<idle hint or "looks around">}` for things with a stand or look tag, `{pick:x}` when the hands are free, `{put:held@x}` on a surface while holding, `{come}` with low weight when far from home, and when seated 60 % `{wait}` and 40 % `{stand}`. The last two targets are avoided. The chosen tags go to the scene executor through the same path as spoken tags.

**Visibility** (`rooms/room-visibility.ts`). `visibleObjects(room, aspect)` rebuilds the room camera with three.js (no renderer) and keeps objects whose middle and sit or stand spot are all inside the frustum with a 5 % margin. The aspect is the real canvas aspect, so a narrow window sees fewer objects. In the reading room at 16:9 the bookshelf is off to the left and is not offered; at 21:9 it is.

**When talking starts.** The existing interrupt cancels walks and turns. If the avatar wandered since the user last talked, then 1.5 s after the last interrupt (a wake word is usually followed by speech) it queues, according to the setting: *Come back to me*: `{stand}` if seated, then `{come}`, when seated or more than 1.0 m from home; *Turn to me where it is*: a look at the camera position (`lookAtPoint` action, not exposed in the prompt), when standing and facing more than 30 degrees away. A seated avatar stays seated for *Turn to me*. The decision is made when the queued item's turn comes (`SceneActionExecutor.submitPlan`), from where the avatar is by then.

**The conversation knows.** The director keeps the last 8 idle actions with their time (`recent()`) and `recentSummary()` gives those of the last 10 minutes, such as "walked to the bookshelf (browses the books); sat down on the armchair". The room part of the session instructions then ends with "Just before this, while idle, you: …". It is updated only when the summary changed and the assistant is not transcribing, thinking or responding.

Code: `idle-director.ts` (timing and state, with injected clock, timers, random, model and executor, so it is unit tested), `idle-actions.ts` (parse, validate, fallback, log text), `idle-prompt.ts`, `idle-talk.ts`, `room-visibility.ts`, `use-idle-director.ts` (React hook; used by `App.tsx`). Main process: `app/main/src/rooms/idle-thoughts.ts`, `idle-settings.ts`, `idle-habits.ts`.

Limits: idle actions use the same stream path as spoken tags, so a user interrupt cancels a walk in progress where it is; the reaction to talking starts 1.5 s after the last interrupt and a later speech-start interrupt can still cancel a walk back home. Walk-home and turn-to-camera happen only after an idle action, not after a walk the assistant chose in conversation. The camera aspect is read when an idle decision is made, not tracked live.

## What's next

- Generation: build a `RoomFile` from a text description, save it under `<userData>/rooms`, and load GLB models for objects.
- Generation: build a `RoomFile` from a text description, save it under `<userData>/rooms`, and load GLB models for objects.
