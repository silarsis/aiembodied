# Switchboard API

JSON over HTTP and WebSocket on `127.0.0.1:8196`. Errors are `{"detail": "..."}` with 404, 413 (payload over
64 KB) or 422 (bad shape).

## Event envelope

```json
{
  "id": "01JC5X8Q2M4N6P8R0T2V4W6Y8Z",
  "type": "task.status",
  "v": 1,
  "at": "2026-11-10T12:34:56.789Z",
  "producer": {"kind": "tool", "id": "coding", "node": "bija"},
  "to": ["avatar:echo", "scene:lounge"],
  "scene": "lounge",
  "txn": {"id": "task:20261108-1a2b", "parent": "turn:42", "root": "turn:42", "cause": "<event id>",
          "state": "progress", "title": "Add a hello file", "deadline": "2026-11-10T13:00:00Z"},
  "audience": "household",
  "priority": "normal",
  "expires": "2026-11-10T14:00:00Z",
  "payload": {}
}
```

- `id` (ULID, 26 characters) and `at` are optional on publish; the server assigns them. Times are stored as UTC with
  milliseconds and `Z`. Publishing an `id` that is already journaled changes nothing and returns the same id, so a
  client can safely retry a batch.
- `type` is dotted lower-case (`avatar.utterance`, `tool.result`, `task.status`, `approval.requested`).
- `producer.kind`: `avatar, person, tool, service, sensor, device, remote`.
- `to` holds addresses `<kind>:<id>`; kinds are the producer kinds plus `scene` and `cap`. Empty means observers only.
- `audience`: `private, household` (default), `shareable`. `priority`: `low, normal` (default), `high, urgent`.
- `payload` is any JSON object, at most 64 KB serialised.
- `txn` is optional (see Transactions). `state`: `open, accepted, waiting, progress, done, failed, cancelled, expired`.

## HTTP

- `GET /health` -> `{"ok": true, "version": "0.1.0", "node": "bija", "events": 120, "open_txns": 3, "clients": 1}`
- `POST /v1/events` one envelope, or `{"events": [...]}` (1 to 500) -> `{"ids": [...]}`. All events are validated first;
  if one is bad (422) none is stored. Events are journaled, applied to the ledger, then sent to live subscribers.
- `GET /v1/events?since=<id>&type=<glob>&producer=<kind:id>&txn=<id>&root=<txn root>&scene=&to=<address>&limit=200`
  -> `{"events": [...], "next": "<last id>" | null}`, oldest first, `limit` up to 1000. `since` is exclusive; an id that
  is not in the journal (for example pruned) is compared as a plain ULID. `type` is a glob (`task.*`).
  Pass `next` as `since` to continue.
- `GET /v1/txns?state=open|closed|<state>&root=&limit=200` -> `{"txns": [...]}`, newest updated first. `open` means
  not closed (any of `open, accepted, waiting, progress`), `closed` means `done, failed, cancelled, expired`.
- `GET /v1/txns/{id}` -> `{"txn": row, "children": [rows], "events": [envelopes, oldest first]}`; 404 if unknown.

A txn row: `id, parent, root, state, title, opened_by, owner, opened_at, updated_at, closed_at, deadline, last_event`.

## Transactions

- Any event with `txn.id` creates or updates the row. A new row starts as `txn.state` or `open`; `opened_by` is the
  producer. `root` is `txn.root`, else the parent's root (the parent itself if it is not known yet), else the txn's own id.
- `txn.state` sets the state while the txn is not closed. A closed txn (`done, failed, cancelled, expired`) ignores
  later state changes; the event is still journaled.
- `owner` is the producer of the first event that moved the txn out of `open` (`accepted` or later).
- When a txn closes, each open child becomes `cancelled` and the switchboard publishes a `txn.cancelled` event for
  it (producer `service:switchboard`, payload `{"reason": "parent closed", "parent": "<id>"}`); that cascades down.
- Every 5 seconds, open txns past their `deadline` become `expired` with a `txn.expired` event (payload `{"deadline": ...}`).

## WebSocket `/v1/stream`

1. Client: `{"op": "hello", "actor": "avatar:echo" | null, "subscribe": {"types": ["*"], "to": ["avatar:echo", "scene:lounge"], "observe": true}, "since": "<event id>" | null}`.
   `types` are globs (default `["*"]`); `observe` defaults to false.
2. Server: `{"op": "welcome", "node": "bija"}`. With `since`, matching journal events after it follow, then live ones.
3. Server: `{"op": "event", "event": {...}}` for each event whose type matches and that is either observed (`observe`
   true) or addressed to one of `subscribe.to`.
4. Client may send `{"op": "publish", "event": {...}, "ref": "r1"}` -> `{"op": "ack", "ref": "r1", "id": "..."}` or
   `{"op": "error", "ref": "r1", "message": "..."}`, and `{"op": "ping"}` -> `{"op": "pong"}`.

A bad first message gets `{"op": "error"}` and the socket is closed (1008). Each client has a queue of 1000
messages; a client that falls further behind is dropped with close code 1013 and should reconnect with `since`.
