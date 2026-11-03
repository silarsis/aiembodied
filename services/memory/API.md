# Memory engine HTTP API

JSON over HTTP, default `http://127.0.0.1:8194`. Times are ISO 8601; send them with a zone
(`2026-11-03T08:00:00Z`). IDs are UUIDs. When `MEMORY_API_TOKEN` is set, every `/v1` route needs
`Authorization: Bearer <token>`. Errors are `{"error": "..."}`; 503 means the database is not
reachable yet, and the client should queue and retry.

## `GET /health`

```json
{"status": "ok", "version": "0.1.0", "database": "ready", "schema": "memory", "schema_version": 2,
 "embedder": "BAAI/bge-small-en-v1.5", "counts": {"sessions": 12, "messages": 340, "indexed": 160}}
```

`status` is `starting` (with `error`) until the database is reachable and migrated. `embedder` is
null when embeddings are off; `embedder_error` says why the model failed to load.

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

## `GET /v1/search?q=&from=&to=&agent=&kind=&include_private=true&exclude=&mode=hybrid&limit=10`

Search the recall index (turns and facts), best first. `mode=hybrid` (default) merges full-text
and vector matches; `mode=text` is full text only. `kind` may repeat (`turn`, `fact`); `exclude`
is a comma-separated list of result ids to leave out. Each result has `id`, `kind`, `source_id`,
`session_id`, `agent`, `period_start`, `period_end`, `text`, `score`, `similarity` (cosine, when
both sides are embedded) and `matched` (`["text", "vector"]`).

## `POST /v1/activity`

`{"busy": true}` when a turn starts and `{"busy": false}` when it ends. Background summaries
only run once the client has been idle (not busy, nothing written) for `MEMORY_IDLE_SECONDS`.
A busy flag that is never cleared expires after ten minutes.

## `POST /v1/summaries/run`

`{"now": "<optional ISO time>", "limit": 10}`: do due summaries now, idle or not, and return
what was done. 409 when no summary model is configured.

## `GET /v1/summaries?kind=&from=&to=&limit=100`

Summaries newest first. `kind` is `session`, `day`, `week` or `month`. Each has `title`,
`text`, `topics`, `period_start`, `period_end` and `model`. Search results, `/v1/memories/{id}`
and the timeline carry them too, as kinds `session`, `day`, `week` and `month`.

## `GET /v1/brief?session_id=&agent=`

For the start of a conversation: active, non-private `facts` (pinned first, then newest, up to
about 1,200 characters) and `last_session`, the most recent conversation other than
`session_id`, with its `summary` (once made) and last three turns, and `recent_days`, up to two
day summaries from the past week. The client adds the date and time and formats it.

## `POST /v1/recall`

```json
{"text": "how are the tomatoes going", "session_id": "...", "exclude": ["<ids recalled earlier>"],
 "limit": 3, "max_chars": 1600, "min_similarity": 0.6}
```

Returns `{"items": [...search results...], "reason": null}`, or no items with a `reason`:
`short` (under four words), `no embedder`, or `no strong match`. Results from `session_id` and
private items are left out. Each call is logged.

## `GET /v1/recall-log?session_id=&limit=50`

What auto-recall was asked and returned, newest first. Forgetting a session or a message removes
its entries.

## `GET /v1/timeline?from=&to=&agent=&include_private=true&turns=6&limit=50`

Conversations that took place in `[from, to)`, oldest first, each with `title`, `agent`,
`channel`, `started_at`, `last_at`, `message_count`, its `summary` (or null) and up to `turns`
turns (`id`, `at`, `text`). `summaries` holds the period summaries inside the range: days for
spans up to about a month, weeks up to about four months, months beyond (none for two days or
less).
400 if `to` is not after `from`.

## `GET /v1/memories/{id}?around=1`

One search or timeline result in full. For a turn: its messages and `around` turns either side.
For a fact: the fact and the messages it came from. 404 if it isn't there.

## `PUT /v1/facts/{id}`

```json
{"text": "Kevin prefers wslc over Docker", "subject": "tools", "author": "agent", "agent": "Echo",
 "session_id": "...", "source_message_ids": [], "supersedes": null, "pinned": false, "private": false}
```

Save a fact; it is live at once. A repeat of the same id is ignored (`created: false`). With
`supersedes`, the older fact is marked superseded and leaves search. An unknown `session_id` is
dropped rather than refused, because the session's own write may still be queued.

## `GET /v1/facts?status=active&pinned=&subject=&unreviewed=false&include_private=true&limit=200`

Facts, pinned first then newest. `status` is `active`, `superseded`, `retracted` or `all`.

## `PATCH /v1/facts/{id}` and `DELETE /v1/facts/{id}`

Change `text`, `subject`, `pinned`, `status` or `private`, or pass `"reviewed": true` to mark it
reviewed. Only active facts are searchable. DELETE forgets it entirely.

## `DELETE /v1/sessions/{id}` and `DELETE /v1/messages/{id}`

Forget a session, or one message, and everything indexed from it. 404 if it isn't there.
