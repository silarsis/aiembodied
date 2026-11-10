# 3D rooms

**Status:** Step 2 shipped (scene runtime and selector). Step 4 (describing a room) and step 5 (making missing objects locally) are implemented and unit tested without network or GPU; see their sections for what was not checked on real hardware. Step 3 (walking, sitting, looking and picking things up) and step 3b (idle wandering) are implemented in the app and in `services/motion`. Neither step has been run end to end on a real display with the ARDY model at merge time: the room renderer was checked with a software WebGL screenshot, and the physics, navigation, planner and executor with unit tests. The grip pose and the hand-held object look are unchecked by eye.

Controls → Backgrounds now has two tabs, **2D pictures** and **3D rooms**. Picking a room puts the avatar inside it: the room is loaded into the avatar's three.js scene with physics colliders, a navigation mesh and a fixed camera. The 2D picture and its ground shadow are hidden while a room is active. The Backgrounds item in the drawer shows the room's name.

## What exists

- Two built-in rooms, both made only of boxes, cylinders and spheres: **Reading room** (sofa, armchair, coffee table, bookshelf, floor lamp, side table, rug, a mug) and **Studio flat** (desk and chair, bed, kitchen counter, bedside table, plant, rug, a mug). Each is about 6 m by 5 m by 2.8 m with a window on the north wall and a door on the east wall.
- The avatar stands at the room's home spot, about 2.4 m in front of the camera, facing it. Its soles rest on the floor (the 2D normalisation puts the ankle bone on y = 0, so rooms lift it by the measured sole depth) and it is scaled to **Avatar height in rooms** (3D tab, default 1.6 m head to toe, 1.0 to 2.2 m, saved with the idle settings under `rooms.idle`), because the 2D stage sizes avatars to fill the frame and they would tower over real-size furniture. Leaving the room gives back the 2D size. Scene actions read the scale live, so walking, sitting and reaching keep working at any height. The canvas fills the stage instead of the fixed 480 by 640 pixels, so the same room works on a portrait or a landscape window.
- Dynamic props (the mug) are rigid bodies and settle on the table. The avatar is a kinematic capsule that follows the avatar's position and can push them.
- Choosing another room, or going back to a picture or the plain background, disposes the old room, puts the avatar back at the origin facing forward, restores the 2D camera and cancels any live motion clip and queued animations.
- On a 2D picture the hips' horizontal travel is removed from live `{move:...}` clips so the avatar stays on its spot (the height is kept). In a room the travel is kept, and the scene actions below turn it into real root motion.
- With the metrics HUD flag on, the 3D tab has a **Show walkable area** checkbox that draws the navigation mesh over the room.
- Describing a room builds a new one (step 4, below); objects the library lacks can be made locally (step 5, below).

## Scene format

Rooms are JSON files (`RoomFile` in `app/main/src/rooms/types.ts`, checked by `validateRoomFile` in `validate.ts`). Built-in rooms live in `app/main/assets/rooms/<name>.json` and have the id `room:builtin:<name>`. Saved rooms live in `<userData>/rooms/<uuid>/room.json` with the id `room:<uuid>`; a saved file that fails validation is skipped with a console warning. The active room is stored under the same `stage.activeBackground` key as pictures; any id starting with `room:` must exist.

- `shell`: floor-centred box (`width` along x, `depth` along z, `height`), colours, optional ceiling, `openings` (windows and doors with `wall`, `offset` from the wall's centre along +x or +z, `width`, `height`, `sill`) and an `outside` colour seen through windows. Walls are 0.1 m thick, built around the openings.
- `objects`: `id` (unique slug), `name`, `position` (y is the floor contact), `rotationY`, `size` (bounding box used for colliders and navigation obstacles), `parts` (primitive geometry relative to the object origin), `collider` (`box` by default, `none` for the rugs), `dynamic`, and `tags`. `model` is either `{asset, file, scale}` (a library model, see Describing a room) or the old room-folder `{file}` form, which is validated but never fetched.
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
- **Turn first:** when the path sets off more than 60 degrees from where the avatar faces (measured 0.4 m along it), the avatar first turns on the spot: a target holding the root at the start with the path's starting heading at 0.5 to 1.1 s (longer for bigger turns), and the walk starts 0.2 s after it (`walkStart` in `rooms/scene-actions.ts`). This also applies to the walk before sitting. Tight spots between furniture can still need a short sidestep or backward step, which the model chooses.
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

## Describing a room (step 4)

**Status:** Implemented and unit tested with all network mocked. Not run end to end against api.polyhaven.com or a real language model at merge time (the build container cannot reach Poly Haven), and the downloaded models have not been looked at in the real renderer.

Controls → Backgrounds → 3D rooms has a **Room description** box and **Build room** button. Describe a place ("a cosy reading room with an armchair by the window and a wall of books") and the app:

1. **Plans** it: the **Room layout** model (a Models and servers job, `scenelayout`, starting out on Thinking's server and model) writes a JSON layout: shell size, floor and wall colours, windows, door, a lighting preset and up to 14 objects, each with a library search phrase, category, approximate size, colour word and a placement (`against` a wall, `near` another object, `on` a surface, `facing`, `corner`). One request at temperature 0.4 and about 2500 tokens; JSON mode is asked for and dropped if the server rejects it; an unusable reply is sent back once with the problem, then the build fails with a clear message. "Unusable" means the room as a whole: no shell, or not one usable object. A single bad object (no name, no size) is left out and logged, and a wall word that is not north/south/east/west becomes "none". Categories are open: the known ones (seat, table, storage, bed, lamp, decor, plant, prop, appliance) drive sitting, surfaces, wall snapping, the library filter, the fallback shape and the make order, so any other word the model writes is mapped onto one of them by a word table (sofa → seat, bookcase → storage, rug → decor, then the object's name for vague words like "furniture") and anything left becomes a prop. The model's own word is kept as the object's `label`. Code: `room-layout.ts` (schema, checks, ids/colours), `room-layout-prompt.ts`, `room-layout-llm.ts`.
2. **Finds furniture**: each object goes through the object sources. The first source is the Poly Haven library (below); an object nothing matches gets simple shapes (seat = base, back and arms; table = top and legs; storage = shelves; bed; lamp; plant; mug or box) in the colour the layout names.
3. **Arranges** it: `room-placer.ts` solves positions deterministically for a seed.
4. Saves `<userData>/rooms/<uuid>/room.json` with `layout.json` (what the model wrote) and `generation.json` (description, seed, warnings, which objects fell back, which library model each got). The new room is selected.

Progress shows as "Planning the room", "Finding furniture (3/9)", "Arranging", "Done", with notes afterwards ("Couldn't find a rocking chair, used a simple shape."; "Left out the wardrobe: there was no room"). One room is built at a time and **Cancel** stops it. Saved rooms have a **Delete** button (built-in rooms do not), and clicking a saved room puts its description back in the box. IPC: `rooms:generate` (progress on `rooms:generate-progress`), `rooms:cancel-generate`, `rooms:delete`.

### The placer

- Dimensions are clamped (width and depth 3 to 10 m, height 2.4 to 3.5 m). The camera is on the south side (z = depth/2 - 0.4, y 1.5, fov 50) looking north; home is 2.3 m in front of it facing it.
- Keep-clear zones: a 0.7 m square around home for everything, the sight line between camera and home for tall things (over 0.85 m), the strip in front of the door for everything, and the strip under each window for tall things.
- Order: objects against a wall (largest first, along the wall on a 10 cm grid; corner objects prefer the ends), free objects that others are `near`, `near` objects (on the side facing the room centre, facing their anchor), the remaining free objects, rugs and other flat things under the furniture group, then `on` objects on their surface's top. A turn towards a named `facing` target happens last. Footprints (rotated rectangles) keep a 10 cm gap and stay inside the walls. An object that does not fit is left out with a warning; one that cannot go against its wall is tried in the open floor first.
- Walkability (`room-walkability.ts`): a 10 cm floor grid with the navmesh's clearances (0.3 m from walls, 0.35 m from furniture) is flood filled from home. Every seat needs a reachable stand spot (in front, else behind or beside), and every surface and every grabbable prop needs reachable floor within 0.9 m of the footprint it rests on. If not, the placer moves or drops the smaller free and `near` objects, then the object itself. The real navmesh is still built in the renderer.
- Tags: seats and beds get `sit` (at `seat_height`) and `stand`; tables, counters, shelves and appliances get `stand`; tables and `surface` objects get `surface.height` (shelves 1.0 m at most); grabbable props are `dynamic` with `grab` at the top centre; every object has `look`; an idle hint becomes `tags.idle`.

### Poly Haven models

The library is **Poly Haven** (https://polyhaven.com), whose models are **CC0** (public domain): no attribution or licence is needed, but they are not bundled; they are downloaded the first time a room needs them.

- Catalog: `GET https://api.polyhaven.com/assets?t=models`, cached in `<userData>/rooms/assets/polyhaven/catalog.json` for 7 days (an old copy is used if the network fails).
- Files: `GET https://api.polyhaven.com/files/<id>`, using `gltf["1k"].gltf` (2k if there is no 1k): the glTF and its `include` files (.bin, textures) go to `<userData>/rooms/assets/polyhaven/<id>/` with the relative layout kept, written as `.part` and renamed, md5 checked when Poly Haven gives one. At most 3 downloads at once. Requests send `User-Agent: aiembodied/<version> room builder`. Paths from the API are checked to stay inside the model's folder and only https URLs are fetched. A failed download makes that object use simple shapes.
- Search (`asset-library/search.ts`, no embedder): tokens of the object's search words, name and category are scored against the entry's name, tags and categories (exact word, plural/stem, a small synonym table); the entry's categories must suit the object's (seat with furniture or seating, plant with plants, and so on); below a threshold nothing is used.
- Size: `asset-library/gltf-bounds.ts` reads the glTF's POSITION accessor ranges through the node transforms (no three.js in the main process). The model is scaled uniformly so its height matches the layout's, with the scale kept between 0.5 and 2; the scaled real size becomes the object's `size`, and the scale goes in `model.scale`.
- Serving: the main process registers `aiembodied-asset://` (standard, secure, fetch-capable, CORS enabled) and serves only files under `<userData>/rooms/assets/`, refusing anything that is not a clean relative path. The renderer's Content-Security-Policy allows the scheme for `img-src` and `connect-src`.
- Loading: `room-model-loader.ts` loads `aiembodied-asset://polyhaven/<id>/<file>` with GLTFLoader, applies `model.scale`, centres the footprint on the object origin with the bottom on the floor. The room appears at once with a grey box of `size` per model object and the models swap in as they load; a model that fails to load stays a grey box. Colliders and the navmesh stay box-based.

### Where step 5 plugs in

`asset-library/library-source.ts` defines `ObjectSource`; `room-generation-setup.ts` builds the list `[Poly Haven, generated objects]`. Whatever neither has is made in the background (next section), and whatever that cannot make still gets simple shapes.

## Making missing objects (step 5)

**Status:** Implemented and unit tested with a fake ComfyUI client (no network, no GPU). Not run end to end against a real ComfyUI with TRELLIS.2 or Hunyuan3D at merge time, so the look of the generated meshes, their facing and their scale are unchecked by eye.

When the Poly Haven library has no good match for an object, the app makes it on this PC with the same ComfyUI path the avatar studio uses, keeps it in a local library, and reuses it in later rooms.

**Settings** (Controls → Backgrounds → 3D rooms → **New objects**, saved as `rooms.objects` in the memory store, read and written through `backgrounds.getObjectSettings` / `setObjectSettings`):

- *Make missing objects*, on by default. The checkbox is hidden, with a hint to set up ComfyUI under Models and servers, when the **Concept image** or **3D model** job has no server.
- *At most this many per room*: 0 to 8, default 3. Models that already exist in the generated library cost nothing and do not count.

**What happens**

1. The room is planned, library objects are found (models made earlier count as library objects), and the placer solves positions. The room is then **saved and shown at once**, with simple shapes for the objects still to be made.
2. Those objects are made **one at a time in the background**, most important first (bed, seat, table, storage, appliance, lamp, plant, decor, prop; larger first within a category). Flat things (under 6 cm high, such as rugs) are never made. Progress reads "Making the rocking chair (1/3)…", and the saved room's card shows a small spinner until the last one is done.
3. Each object: the **image model** (the studio's selected one, without its LoRAs) draws "a single <name>, <colour and material words>, product photo, isolated on plain white background, full object in frame, straight-on front view, no people, no text" (`asset-library/generated-prompt.ts`); the **3D step** turns that picture into a `.glb` using the same graphs as the avatar's front image: TRELLIS.2 (textured) when it is installed, else the studio's selected Hunyuan3D 2mv from the front image alone (an untextured shape). Both graphs cut the object out with BiRefNet themselves, so there is no separate background-removal step; side and back views, painting, rigging and VRM export are skipped. Image and mesh each run on the server Models and servers picks for their job.
4. The object is saved in the generated library and swapped into the room: `room.json` gets its `model`, the size and scale are re-fitted (the model's height is matched to the layout's, as for library models), and the object keeps its placed position and turn. If the real footprint would poke through a wall by up to 25 cm the object is slid in by that much; if it would still leave the room, stand in the avatar's spot or overlap another object, the simple shape stays and a note says so. The main process then sends `rooms:updated`; the renderer reloads that room if it is on stage and leaves the avatar where it is (an open walk, sit or action is not interrupted).
5. One room generation, background objects included, runs at a time: Build room is disabled meanwhile, and **Cancel** stops the background work too (the room stays as it is). Deleting the room being made stops it. Generation does not use any GPU lock of its own: both steps go through the ComfyUI server's queue, so they wait behind an avatar job that is already running there instead of running alongside it.

**Notes after a room.** Objects the library lacked and that will not be made (switched off, over the limit, flat) read "Couldn't find a lamp, used a simple shape." Objects that were made read "Made a new model for the rocking chair."; a failure reads "Couldn't make a desk, used a simple shape."; a made model that did not fit reads "Made a new desk but it would overlap the sofa, so kept a simple shape." `generation.json` records `madeObjects`, `couldNotMake` and `makingNotes`.

**The generated library.** `<userData>/rooms/assets/generated/<slug>-<hash>/` holds `model.glb`, `source.png` (the picture it was made from) and `meta.json` (`name`, `search` words, `category`, `prompt`, `created`, `sourceImage`, `bbox`, plus the seed and model names). A room refers to it as `{asset: "generated/<slug>-<hash>", file: "model.glb", scale}`; the `aiembodied-asset://` protocol already serves anything under the asset cache (`.glb` as `model/gltf-binary`), and the renderer's loader grounds and centres it like a library model. Before making anything, the library is searched with the same scorer as Poly Haven (`asset-library/search.ts`, `generated-library.ts`), so a "rocking chair" made once is reused for a "rocking chairs" later. The bounding box comes from `glbBounds` in `gltf-bounds.ts` (the GLB's JSON chunk, or the vertices when the accessors carry no range). The mesh is assumed to be Y-up with its front towards +Z, as the placer assumes for library models.

**Generated objects list** (same tab): name, the picture and **Delete** for each, so a bad one can be removed (`rooms:generated:list`, `rooms:generated:delete`). A room that used a deleted object (or a Poly Haven model that is no longer cached) shows simple shapes of the same kind, size and colour the next time it loads: `RoomService.load` checks that each model file exists and rebuilds the shapes from `layout.json` (a plain grey box without it).

Code: `asset-library/generated-source.ts` (`GeneratedSource`: reuse, make, list, delete), `generated-library.ts`, `generated-prompt.ts`, `room-refit.ts` (swapping shapes for a model), `object-settings.ts`, the background phase in `room-generation.ts`, and `renderer/src/backgrounds/room-objects.tsx`.

### Limits

- The placer is a heuristic: small odd layouts may drop objects, and `near`/`facing` choices can look stiff. There is no re-roll button yet; build again for another arrangement.
- Library models and generated meshes face whichever way they were made; the placer assumes +Z is the front, so some pieces may look turned.
- Making an object takes minutes (an image, then a 3D build), and a Hunyuan-only setup gives untextured grey shapes. There is no check that the picture shows one clean object. A restart while objects are being made leaves the rest as simple shapes (they are not resumed).
- Objects that stand or sit at a window or door are only kept clear by zones, not by looking at the opening's frame.
