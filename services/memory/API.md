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

## `GET /v1/search?q=&from=&to=&agent=&kind=&include_private=true&exclude=&mode=hybrid&limit=10&touch=false&session_id=`

Search the recall index (turns and facts), best first. `mode=hybrid` (default) merges full-text
and vector matches; `mode=text` is full text only. `kind` may repeat (`turn`, `fact`); `exclude`
is a comma-separated list of result ids to leave out. Each result has `id`, `kind`, `source_id`,
`session_id`, `agent`, `period_start`, `period_end`, `text`, `score`, `similarity` (cosine, when
both sides are embedded) and `matched` (`["text", "vector"]`).

Long texts are also embedded in overlapping windows of a few sentences, and a row's `similarity`
is the closer of its whole and its best window, so a long exchange or summary is found by what it
says past its opening. Kinds: `turn`, `fact`, `handoff`, `session`, `day`, `week`, `month`.

Searching changes nothing, unless `touch=true` (the agent is using what it found): facts among the
results are then refreshed, and counted once per `session_id`. See fading under the facts.

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

For the start of a conversation: active, non-private `facts` (pinned first, then the easiest to
reach, see fading, up to about 1,200 characters); `handoff`, the newest note the agent left in
another conversation (`text`, `agent`, `model`, `written_at`), to be shown whole; and `last_session`, the most recent conversation other than
`session_id`, with its `summary` (once made) and last three turns, and `recent_days`, up to two
day summaries from the past week. The client adds the date and time and formats it.

## `POST /v1/recall`

```json
{"text": "how are the tomatoes going", "session_id": "...", "exclude": ["<ids recalled earlier>"],
 "limit": 3, "max_chars": 1600, "min_similarity": 0.6}
```

Returns `{"items": [...search results...], "reason": null}`, or no items with a `reason`:
`short` (under four words), `no embedder`, or `no strong match`. Results from `session_id` and
private items are left out. Each call is logged. Facts it returns count as used (see fading).

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

## `GET /v1/memories/{id}?around=1&touch=false&session_id=`

One search or timeline result in full. For a turn: its messages and `around` turns either side.
For a fact: the fact and the messages it came from. 404 if it isn't there. With `touch=true` a
fact counts as used.

## `PUT /v1/facts/{id}`

```json
{"text": "Kevin prefers wslc over Docker", "subject": "tools", "author": "agent", "agent": "Echo",
 "session_id": "...", "source_message_ids": [], "supersedes": null, "pinned": false, "private": false,
 "model": "qwen-next-flash"}
```

Save a fact; it is live at once. A repeat of the same id is ignored (`created: false`). With
`supersedes`, the older fact is marked superseded and leaves search. An unknown `session_id` is
dropped rather than refused, because the session's own write may still be queued. `model` is
the model that wrote it (the background extractor fills in its own).

## `GET /v1/facts?status=active&pinned=&subject=&unreviewed=false&include_private=true&limit=200`

Facts, pinned first then newest. `status` is `active`, `superseded`, `retracted` or `all`. Each
also has `model`, `recall_count` (conversations it was used in), `last_recalled_at` and
`accessibility`.

**Fading.** `accessibility` is 2^(−days since last used ÷ half-life). The half-life is 30 days and
doubles with each conversation the fact was used in, up to four times (480 days); pinned facts stay
at 1. It is worked out when read, and only decides what the brief has room for: a faded fact is
still searchable, and nothing is deleted. Used means returned by auto-recall, or by search or
`/v1/memories` with `touch=true`; the Memory panel's looking doesn't count.

## `POST /v1/facts/correct`

```json
{"id": "<fact id or its search result id>", "about": "or what it said, instead of id",
 "action": "replace", "text": "Kevin drives a red Mazda", "new_id": "...",
 "author": "agent", "agent": "Echo", "model": "qwen-next-flash", "session_id": "..."}
```

Replace a fact with new words (a new fact that supersedes it, keeping its subject, pin, privacy and
use count) or `"action": "retract"` it. Returns `status`: `replaced` (with `fact` and
`replacement`), `retracted`, `ambiguous` (`about` matched more than one; `candidates` lists them
with ids), `not_found`, `not_a_fact` (the id is a conversation or summary, which is a record and
can't be corrected), `inactive` (already superseded or retracted) or `pinned` (only
`"author": "user"` may change a pinned fact). 400 without `id` or `about`, or a replacement
without `text`.

## `PUT /v1/sessions/{id}/handoff`

```json
{"text": "Halfway through the garden plan; ask about the budget.", "agent": "Echo", "model": "..."}
```

The agent's note for its next conversation, at most 2,000 characters. One per conversation:
writing again replaces it. The newest note from another conversation goes in the brief, and
notes are searchable (kind `handoff`). Creates the session if its own write is still queued.
Forgetting the session forgets its note.

## `PATCH /v1/facts/{id}` and `DELETE /v1/facts/{id}`

Change `text`, `subject`, `pinned`, `status` or `private`, or pass `"reviewed": true` to mark it
reviewed. Only active facts are searchable. DELETE forgets it entirely.

## `DELETE /v1/sessions/{id}` and `DELETE /v1/messages/{id}`

Forget a session, or one message, and everything indexed from it. 404 if it isn't there.

## `GET /v1/storage` and `PUT /v1/storage`

```json
{"database": "postgresql://user:password@db.example.com:5432/postgres", "mirror": null}
```

Where memory is kept and the optional mirror. `database: null` is this machine's own database
(`MEMORY_DATABASE_URL`); `mirror: null` turns the mirror off. The answer never contains
passwords:

```json
{"database": {"local": false, "where": "db.example.com:5432/postgres"},
 "mirror": null, "moving": true, "move_error": null}
```

A switch to an empty database copies everything there first; while `moving` is true the other
routes answer 503, and so does another switch. If the current database can't be read or the
copy fails, nothing moves and `move_error` says why. The setting is saved to the settings file and used on the next start. 400 if
an address isn't `postgres://` or `postgresql://` with a host. `/health` includes the same view
under `storage`.

## `POST /v1/storage/test`

`{"url": "postgresql://..."}` → `{"ok": true, "version": "17.2"}` or `{"ok": false, "error":
"the user name or password was refused"}`. Connects and checks pgvector is available. Errors are
general categories; the details go to the engine's log only.

## `POST /v1/storage/push`

Send the mirror what it is missing now → `{"sent": 42}`. 409 when no mirror is set.

