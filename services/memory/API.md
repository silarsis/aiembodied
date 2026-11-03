# Memory engine HTTP API

JSON over HTTP, default `http://127.0.0.1:8194`. Times are ISO 8601; send them with a zone
(`2026-11-03T08:00:00Z`). IDs are UUIDs. When `MEMORY_API_TOKEN` is set, every `/v1` route needs
`Authorization: Bearer <token>`. Errors are `{"error": "..."}`; 503 means the database is not
reachable yet, and the client should queue and retry.

## `GET /health`

```json
{"status": "ok", "version": "0.1.0", "database": "ready", "schema": "memory", "schema_version": 1,
 "counts": {"sessions": 12, "messages": 340, "indexed": 160}}
```

`status` is `starting` (with `error`) until the database is reachable and migrated.

## `PUT /v1/sessions/{id}`

Create or update a session. All fields but `started_at` are optional; a later call fills in what
an earlier one didn't know, and the earliest `started_at` wins.

```json
{"started_at": "...", "agent": "Echo", "channel": "voice", "title": null, "location": null,
 "ended_at": null, "meta": {"agent_id": "..."}}
```

## `POST /v1/messages`

Up to 500 messages. A message whose `id` is already stored is skipped, so retries are safe. A
message for an unknown session creates it (agent and channel `unknown`) unless the message
carries a `session` object with the details.

```json
{"messages": [
  {"id": "...", "session_id": "...", "role": "user", "content": "...", "created_at": "...",
   "speaker": null, "location": null, "private": false, "meta": {}},
  {"id": "...", "session_id": "...", "role": "tool", "content": "<result text>", "created_at": "...",
   "tool": {"name": "web_search", "arguments": {"query": "..."}, "ok": true}}
]}
```

`role` is `user`, `assistant`, `tool` or `system` (stored, not indexed). Returns
`{"inserted": 2, "duplicates": 0}`.

## `GET /v1/sessions?from=&to=&agent=&limit=50&before=`

Sessions with any activity in `[from, to)`, newest first, each with `message_count` and
`ended_at` (the last message's time while it is open). `next` is the cursor for the following
page, passed as `before`.

## `GET /v1/sessions/{id}/messages`

Every message of a session in time order.

## `GET /v1/search?q=&from=&to=&agent=&kind=&include_private=true&limit=10`

Full-text search (web-search syntax: quotes, `or`, `-word`) over the recall index, best first.
Each result has `kind` (`turn` for now), `session_id`, `period_start`, `period_end`, `text` and
`score`.

## `DELETE /v1/sessions/{id}` and `DELETE /v1/messages/{id}`

Forget a session, or one message, and everything indexed from it. 404 if it isn't there.
