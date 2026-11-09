# 3D rooms

**Status:** Step 2 shipped (scene runtime and selector). Not run end to end on a real display at merge time; the room renderer was checked with a software WebGL screenshot and the physics and navigation code with unit tests.

Controls → Backgrounds now has two tabs, **2D pictures** and **3D rooms**. Picking a room puts the avatar inside it: the room is loaded into the avatar's three.js scene with physics colliders, a navigation mesh and a fixed camera. The 2D picture and its ground shadow are hidden while a room is active. The Backgrounds item in the drawer shows the room's name.

## What exists

- Two built-in rooms, both made only of boxes, cylinders and spheres: **Reading room** (sofa, armchair, coffee table, bookshelf, floor lamp, side table, rug, a mug) and **Studio flat** (desk and chair, bed, kitchen counter, bedside table, plant, rug, a mug). Each is about 6 m by 5 m by 2.8 m with a window on the north wall and a door on the east wall.
- The avatar stands at the room's home spot, about 2.4 m in front of the camera, facing it. The canvas fills the stage instead of the fixed 480 by 640 pixels, so the same room works on a portrait or a landscape window.
- Dynamic props (the mug) are rigid bodies and settle on the table. The avatar is a kinematic capsule that follows the avatar's position and can push them.
- Choosing another room, or going back to a picture or the plain background, disposes the old room, puts the avatar back at the origin facing forward, restores the 2D camera and cancels any live motion clip and queued animations.
- On a 2D picture the hips' horizontal travel is removed from live `{move:...}` clips so the avatar stays on its spot (the height is kept). In a room the travel is kept. The next step turns it into root motion.
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
| `room-scene-controller.ts` | Switches the avatar renderer between 2D and room mode (canvas size, camera, avatar placement). |
| `room-thumbnail.ts` | Renders the selector's card images, or nothing where WebGL is missing. |

The navmesh is built from the floor with every non-dynamic collider's footprint cut out, so furniture is never walkable on top. Paths therefore keep about 0.3 m from furniture and walls, and a target inside furniture (such as a sit position) snaps to the nearest floor beside it.

## What's next

- Motion tools: walk along a path, sit, stand up and pick up an object, using `findPath` and the tags. Live clips become root motion in rooms.
- Idle director: use `idle` tags and `look` points to give the avatar things to do between turns.
- Generation: build a `RoomFile` from a text description, save it under `<userData>/rooms`, and load GLB models for objects.
