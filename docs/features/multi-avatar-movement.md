# Movement for every avatar (phase 3 step 4c): design

Status: design, written 2026-11-11. Phase A is built (see the note under the phases). Phases are listed at the end with what has been built.

## Where we are

Only Echo moves. The pieces that make her move are all single-avatar:

| Piece | File | What ties it to Echo |
| --- | --- | --- |
| `{move:…}` gestures and scene tags in a reply | `App.tsx` (`handleAssistantText`, the `!speaker` guard) | Other speakers' tags are dropped |
| Motion chunks from the motion service | `App.tsx` `onMotionChunk` → `enqueueMotionChunk(animationBus, …)` | Chunks carry a `streamId` only; the bus request has no `avatarId` |
| Scene actions (`{go:}`, `{sit:}`, `{pick:}` …) | one `SceneActionExecutor` in `App.tsx` | One queue, one `AvatarState` |
| The avatar in the room | `RoomSceneController.sceneEnv` (`RoomSceneEnv`) | `host.rig()` is Echo's rig |
| Physics capsule | `RoomPhysics.setAvatarPosition` | One kinematic capsule |
| Idle wandering | `useIdleDirector` → the one executor | One director |
| Scene instructions in the prompt | `buildSceneInstructions(room, …)` in Echo's session instructions | Other avatars' prompts never mention the room |

Other avatars stand still at `companionHome(home, index)` (`room-companions.ts`).

The motion service generates one stream at a time (`lock` in `services/motion/.../app.py`), at roughly 0.2 s per 2 s chunk, so two avatars moving at once simply take turns generating. No change is needed there.

## Goals

1. Any avatar can gesture (`{move:…}`) in 2D and in rooms.
2. Any avatar can walk, sit, look and carry in a room, driven by tags in its own replies.
3. Avatars do not walk through each other, stand on the same spot or sit on the same seat.
4. Idle wandering works with several avatars without the room turning into a crowd scene.
5. With one avatar nothing changes: same code path, same timing.

Not in scope: avatars handing objects to each other, avatars following each other, per-avatar cameras.

## Design

### 1. A `MovementRig` per avatar

Today the executor, its env and its bridge are created in three places. Group them:

```ts
// app/renderer/src/rooms/movement-rig.ts
export interface MovementRig {
  avatarId: string;
  executor: SceneActionExecutor;   // own queue, own AvatarState
  env: RoomSceneEnv | null;        // set while a room is showing
}
export class MovementRigs {
  get(avatarId: string): MovementRig;           // made on first use
  forStream(streamId: string): MovementRig | null;
  interruptAll(): void; resetAll(): void; drop(avatarId: string): void;
}
```

- `MovementRigs` lives in `App.tsx` in place of the single `sceneActions`. `rigs.get('echo').executor` is the same object as today's `sceneActions`, created the same way, so Echo's path is unchanged.
- Each executor gets its own `SceneBridge`. `streamMotion` and `cancelMotion` are shared; `playChunk` enqueues on the animation bus **with that avatar's id** (the bus already routes requests by `avatarId`); `avatarRest` reads that actor's rest skeleton (`AvatarActor` already keeps one per actor; expose it through the renderer's imperative handle or a getter keyed by id).
- Stream ownership: the executor already knows which stream ids it started (`handleChunk` returns false for others). For plain gestures started outside an executor, `MovementRigs` keeps `streamId → avatarId` so `onMotionChunk` can play the chunk on the right actor.

### 2. A `RoomSceneEnv` per avatar

`RoomSceneController` keeps `envs: Map<avatarId, RoomSceneEnv>`:

- Echo's env is today's `sceneEnv` (same object, same host).
- A companion's env is made in `attachCompanion(id, root, humanoid, restHipsHeight)` with a host whose `rig()` is that companion's rig. `RoomCompanions` already stores the base transform; it now also stores the `AvatarRig`.
- `controller.envFor(avatarId)` gives it to the renderer, which hands it to `rigs.get(avatarId).executor.setEnv(...)` the same way it does for Echo today.
- `step(dt)` steps every env. `releaseHeld()` runs for every env when the room goes away.

`PlanWorld` gains one optional field:

```ts
/** Other avatars in the room: where they stand now and where they are heading. */
others?: Array<{ id: string; x: number; z: number; goal?: { x: number; z: number } }>;
```

filled by the controller from the other envs' roots and from the reservations below.

### 3. Not bumping into each other: reservations, not a crowd simulation

A full crowd solver is not worth it for two or three avatars. Use claims on a shared `RoomOccupancy` object owned by the controller:

- **Spots.** When an executor plans a walk, it claims the goal point (radius 0.45 m, i.e. a bit under two `AVATAR_RADIUS`). If the goal is inside another avatar's standing spot or claimed goal, the planner moves it to the nearest free walkable point (`closestWalkable` on candidates in a ring around the wanted point, at most 1 m away). If none is free, the action is skipped with reason "someone is standing there".
- **Seats and objects.** `{sit:x}` claims seat `x`; `{pick:x}` claims object `x`. A claimed seat or a held object makes the action fail fast with a reason the LLM sees in its next turn ("Sage is sitting on the sofa").
- **Paths.** After `findPath`, check each segment against the other avatars' *standing* spots (not their paths). If it passes within 0.45 m, insert a side-step waypoint around the spot (try left then right, keep the one on the navmesh). One pass only; if it still collides, walk anyway. Two avatars walking at once can still cross paths; accept that for now and stagger instead (next point).
- **Stagger.** Only one avatar may be in a *walking* action at a time. A second walk waits in its executor's queue until the first one's walk action finishes (a shared async mutex in `RoomOccupancy`, 15 s timeout, after which it proceeds). Gestures, looks and sits-in-place do not take the mutex.
- Claims are released when the action ends, fails, or is interrupted, and all at once on room change.

Physics: `RoomPhysics` gets `setAvatarPosition(id, x, z)` with one kinematic capsule per avatar, so props are pushed by whoever walks into them. The capsules do not collide with each other (kinematic), which is what we want given the reservation scheme.

### 4. Whose tags are whose

`handleAssistantText(content, avatarId)` in `App.tsx` already knows the speaker. Replace the `!speaker` guard:

- `const rig = rigs.get(speaker ?? 'echo')`, then the existing loop, using `rig.executor` and the speaker's rest skeleton.
- `sceneActionFilterRef` and `moveRequestFilterRef` become per-avatar (a `Map`), so two avatars saying `{sit:sofa}` are not treated as a repeat.
- Tool-call rows for moves get the avatar's name in the label when it is not Echo.

Barge-in (`sceneActions.interrupt()` in three places) becomes `rigs.interruptAll()` for "Kevin spoke", and stays Echo-only where it is tied to Echo's own turn.

### 5. Each avatar's prompt must describe the room

Today only Echo's session instructions include `buildSceneInstructions`. Other avatars get `avatarInstructions(avatarId)` in main, which knows nothing about the room, so they would never emit scene tags.

- The renderer already builds the scene text. Send it to main once per change: `floor.setSceneNotes({ scene: string, others: Record<avatarId, string> })` (new IPC `floor:set-scene`), kept in memory in main.
- `avatarInstructions(avatarId)` appends the scene text for non-Echo avatars. Echo keeps getting hers from the renderer, as today.
- The scene text gains one line per other avatar: "Sage is sitting on the sofa." / "Echo is standing by the window." built from each rig's `AvatarState` and nearest object. This is also what makes "go and sit next to Sage" possible.
- The move/animation tag instructions (`animation-instructions.ts`) are appended the same way, so other avatars know `{move:…}` exists at all. Check what they get today before adding: a 2D-only gesture test is phase A.

### 6. Idle wandering

One `IdleDirector` per avatar would triple the idle LLM calls and fill the room with motion. Instead keep **one director** and let it pick *who* acts:

- `useIdleDirector` takes `rigs` and the list of avatars in the room. Each tick it picks one avatar (round-robin, skipping any that is speaking, mid-action, or acted in the last N seconds; Echo twice as often as the others) and runs today's logic against that avatar's executor and state.
- The idle prompt names the avatar and lists the others' positions (from §5).
- Restlessness and idle habits stay per character (habits are already saved per VRM model).
- Idle talk (`idle-talk.ts`) stays Echo-only for now; avatar-to-avatar idle talk can later go through the floor as a chatter line.

## Phases (one small PR each; each keeps single-avatar behaviour identical)

| Phase | What | Test on bija |
| --- | --- | --- |
| A | Gestures for every avatar: per-avatar chunk routing (`MovementRigs` with executors but no envs yet), `{move:…}` from a non-Echo speaker plays on that avatar, in 2D and standing in rooms; non-Echo prompts get the move-tag instructions | Ask Sage to wave; only Sage moves. Echo's gestures unchanged |
| B | Env per avatar in rooms: `envFor`, companions get executors with envs, scene tags from non-Echo speakers run; scene text sent to main and added to other avatars' prompts; physics capsule per avatar | "Sage, go and sit on the sofa." Sage walks and sits; Echo stays |
| C | `RoomOccupancy`: spot, seat and object claims, path side-step, one walker at a time, `others` in `PlanWorld` and in the scene text | Send both to the same seat; second one gets told it is taken. Walk one past the other |
| D | Idle director picks among avatars | Leave them idle for a few minutes |

Risks to watch on bija: rest-skeleton differences between bodies (arm offsets are per avatar already; verify on a non-default body), `JumpDetector` warnings when a companion is first moved by its executor, and seams when two streams are generated back to back (the service keeps sessions per stream, so this should hold).

### Built: phase A (2026-11-11)

Gestures work for every avatar. What differs from the design above:

- `rooms/movement-rig.ts` holds a small `MovementRigs` with only what phase A needs: `registerStream`/`avatarForStream`/`endStream` (capped at 64 streams, ids kept 5 s after the request resolves so late chunks still route), `filterFor(avatarId)` (one `MoveRequestFilter` per avatar), `streamIds()` and `drop()`. There are no executors or envs yet; phase B adds them next to the filter map. Echo keeps its own `sceneActions` executor and filter in `App.tsx`.
- `getAvatarRestSkeleton(avatarId = 'echo')` / `setAvatarRestSkeleton(skeleton, avatarId = 'echo')` keep one skeleton per avatar; every `AvatarActor` publishes under its own id.
- `enqueueMotionChunk(bus, chunk, hooks, avatarId?)` adds `avatarId` to the bus request unless it is Echo. `onMotionChunk` tries Echo's executor first, then the stream's registered avatar.
- A non-Echo speaker's `{move:}` starts a stream straight away (also standing in a room; no executor), with the label "Sage: waves". Its scene tags are still ignored (phase B).
- Prompts: the renderer sends `{ shared, moveOnly }` over `avatars:set-tag-instructions` (`avatars.setTagInstructions`) when there are 2+ avatars. `shared` is the animation, pose and `{move:}` text (no scene tags) for avatars wearing Echo's body; `moveOnly` is for avatars with a body of their own. Main composes persona + tags in `avatars/tag-instructions.ts` (`composeAvatarPrompt`); with no persona it uses "You are <name>, an AI character who shares a room with Kevin and Echo."
- Barge-in (`interruptMovement` in `App.tsx`) also cancels the registered non-Echo streams.

