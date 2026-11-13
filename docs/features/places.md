# Places

Status: In Progress (step 1 of the "every screen is a place" plan: bija alone).

## What a place is

A place is somewhere an avatar can be. Every screen shows exactly one place, and every avatar is in exactly one place. bija (the big PC) runs the whole app and keeps the truth: which avatar is where.

Today there are two places:

| Id | Default name | Node | Meaning |
|----|--------------|------|---------|
| `home` | the lounge | `local` | The room drawn on this PC's screen. |
| `next-door` | next door | `offscreen` | A place nobody draws. Avatars can go there ("Sage, give us a minute"). |

A later step adds places drawn by another desktop. Their `node` will be that PC's device id. The names can be changed (`PlaceManager.rename`); a Places settings page comes later.

An avatar that is not in the place on screen is not drawn. It does not hear what is said, and it does not answer by itself. It only comes back when it is called.

## Where the truth lives

`app/main/src/places/place-manager.ts` (no Electron imports; the store, clock and bus are injected).

- Places are kept in the memory store under `places.list` (JSON). Built-in places are filled in when missing.
- Locations are kept under `avatars.locations` (`{ avatarId: placeId }`). An avatar with no entry, or one naming an unknown place, is at `home`. Avatars that are not in the registry are ignored.
- `locationOf`, `avatarsAt` (registry order), `isPresent` (at the local place and not in transit), `resolvePlace` (by id or name; ignores case, "the", and hyphens or underscores against spaces).

### Moves

A move has two phases so the screen that will show the avatar can confirm it.

1. `startMove(avatarId, toPlaceId, reason)` puts the avatar in transit. It is now present nowhere (the hallway).
2. It arrives:
   - at an offscreen place, by itself after 1.5 s (`HALLWAY_MS`);
   - at the place drawn here, when the renderer calls `places:arrived`. The renderer does that once the body is loaded and standing at the door, not after the walk in.
3. If nothing confirms the arrival within 10 s (`MOVE_DEADLINE_MS`), the move fails and the avatar is back where it was. The stored location only changes on arrival.

A move to the place the avatar is already at is refused ("already there"). A second move while one is under way is refused ("already moving").

### What is journaled

Each move is one switchboard transaction `move:<avatarId>:<time>:<n>` with events of type `avatar.move` (`scene` = the target place, producer = the avatar, payload `{ avatarId, from, to, reason }`). The transaction is `open` at the start, `done` on arrival and `failed` at the deadline (payload reason "not confirmed in time"). Journaling is fire-and-forget, like the floor journal.

## How avatars move

### The `{room:<place name>}` tag

The places note at the end of every prompt says:

> You are in the lounge. Other places: next door (Sage is there). To go to another place, write {room:<place name>} at the end of what you say: you finish speaking, walk out, and arrive a few seconds later. You only hear and see what happens in the place you are in.

When an avatar writes the tag:

- In a 3D room with live motion, it walks to the first door of the room (`exit` scene action, planned by `planExit`; it stops 0.35 m inside the room). When the walk is over (or was skipped because there is no door) the renderer calls `places:move`.
- In 2D, or without live motion, the move starts after an estimate of how long the line takes to say. The app does not know when the audio of a line ends, so it estimates from the text (about 15 characters a second, at most 8 s).
- An unknown place makes `places:move` return `{ ok: false }`. The renderer logs a warning and nothing else.
- If Kevin speaks while the avatar is still walking to the door, the queued move is dropped like any queued scene action, and the avatar stays.

### Summons

When Kevin speaks, an avatar that is away can be called over, and its turn waits until it is here (`places/summon.ts`):

- Nobody at the local place: the avatar Kevin last talked with (within the partner window), else Echo, else the first avatar, is summoned and answers.
- Kevin names an avatar that is away (`payload.avatarId`): it is summoned first.
- Kevin's line is aimed at an avatar that is away, without naming it in the request: no code reads the words. The floor's chat-model intent step is also told which avatars are away ("In another place right now, and Kevin can call them over") and may pick one. Away avatars are never part of "everyone". If the plan names an away avatar, it is summoned before its turn runs.
- The fine-tuned quick model was trained on "Avatars in the room", so it never sees away avatars. While anyone is away, the quick model is skipped and the chat model reads the line. With nobody away nothing changes.
- If the avatar does not arrive in time, Kevin gets the usual reply error ("Sage did not come over.") and no turn runs.

A summon is a move with the reason `summoned`. The **Call** button on the Elsewhere chip is a move with the reason `called`.

## What the screen shows

- Avatars at the local place and not in transit are on stage. Others are not drawn, are not in the idle director's roster, and are left out of the scene text the others read.
- Echo can be away. Her body stays loaded, but is hidden: she is out of the 2D layout, her physics capsule is parked far away, her spots and seat are released, and her executor is reset. The rest of the app (status, settings, microphone) keeps working. A plain hide is used, not a fade.
- An avatar walking in has its body loaded out of sight first. When it is ready the renderer calls `places:arrived`; the avatar is then shown just inside the room's door, facing in, and walks to its spot (`{come}`, which also nudges it off a spot someone else holds). In 2D, or with no door, it simply appears where it stands.
- A small **Elsewhere** chip lists who is not on stage ("Echo is next door", "Sage is on the way to the lounge") with a **Call** button for each. The button is off while the avatar is already on the move.

## Prompts

Every avatar's system prompt ends with the places note (also chatter turns; never a preview turn). The paragraph is only added when at least two places exist.

## Limits

- The OpenAI Realtime conversation engine is Echo-only and not place-aware. Places work with the local voice engine.
- A place has no devices yet. The microphone, camera and speakers stay with this PC. Per-place presence and devices come with satellite desktops.
- Chatter between avatars happens only among avatars in the same place.
- A move away from this PC that is never confirmed brings the avatar back on screen, but a body that was unloaded appears at its normal spot, not at the door. This can only happen once other desktops exist.
