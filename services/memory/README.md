# Memory engine

Long-term memory for a chat agent. Every message is kept in PostgreSQL, forever unless you delete
it, and can be found again by time, by subject and by relevance. It is a stand-alone service with
an HTTP API: aiembodied is one client, and nothing here depends on it. The design is in the
[eternal memory design doc](https://claude.ai/artifact/VKbfzVfg91QQjFexz8eDr1).

What exists so far (phases 1 to 4):

- **The record.** Sessions and every message verbatim (user, assistant, tool calls with their
  results), with client-made IDs so retried writes are harmless.
- **Turns.** Each user message, the tool calls and the reply after it, indexed together.
  Turns are worked out from time order, so a message that arrives late still lands in the right
  turn.
- **Facts.** Short durable statements ("Kevin prefers wslc over Docker") saved by the agent, the
  user or, later, the background extractor. They go live at once; a fact can be pinned,
  superseded by a newer one, retracted or marked reviewed.
- **Hybrid search.** Full-text and vector search over turns and facts, merged by reciprocal rank
  fusion, with a small boost for recent and important items. Embeddings come from a local model
  on the CPU ([fastembed](https://github.com/qdrant/fastembed), `BAAI/bge-small-en-v1.5`, 384
  dimensions, about 130 MB on first use), made in the background so writes never wait for them.
  Until an item is embedded it is still found by full text.
- **Timeline and detail.** What was talked about over a period, conversation by conversation, and
  any one memory in full with the exchanges around it.
- **Session brief.** `GET /v1/brief`: the saved facts (pinned first) and how the last
  conversation ended, for the client to put in a new conversation's system prompt once.
- **Auto-recall.** `POST /v1/recall`: up to three memories that clearly bear on what was just
  said (cosine similarity 0.6 or more, never from the current conversation or recalled earlier
  in it), or nothing, which is the usual answer. Short turns ("thanks") are skipped. Every call
  is kept in `recall_log` so the thresholds can be tuned. Private items never appear in either;
  only the search tools reach them.
- **Summaries.** In the background, an LLM (any OpenAI-compatible endpoint; the local Qwen by
  default) summarises each conversation once it has been quiet for ten minutes, with a title,
  topic tags and any durable facts it finds. Facts go live at once (author `extractor`) and can
  replace a fact they contradict. Each closed day is then summarised from its conversations, and
  each week (from Monday) and month from its days. All of it is searchable, and the timeline
  and the brief use it. The work only runs while the client is idle (it says when a turn starts
  and ends through `/v1/activity`), so it never competes with a live conversation for the model.
  A late message or a deletion makes the summaries above it due again.
- **Continuity (ideas from [mnemos](https://github.com/Riley-Coyote/mnemos-mcp)).** Long texts are
  embedded in overlapping windows as well as whole, so they are found by what they say past the
  opening. The agent can leave itself a note for the next conversation (a *handoff*), shown in the
  next brief word for word, and can correct or withdraw a saved fact (the old one is kept). Facts
  record the model that wrote them, and fade out of the brief unless they keep being used
  (pinned facts never fade; faded ones are still searchable). See API.md.
- **Forget.** Delete a session, a message or a fact, with everything indexed from it. Deletes are
  recorded as tombstones, which the mirror follows.
- **Move and mirror.** Switch to another database (such as Supabase) while running, copying
  everything into it if it is empty, and optionally copy everything to a second database as it
  arrives. See "Where the data lives".

In aiembodied, Controls → Memory is the panel for checking facts, reading or forgetting
conversations by day, searching, and seeing what was recalled. Controls → Voice & engine → Open
models and servers → Memory picks the database and the mirror.

Summary settings: `MEMORY_LLM_URL` (default `http://127.0.0.1:1234/v1`; `off` disables
summaries), `MEMORY_LLM_MODEL` (default `qwen-next-flash`), `MEMORY_LLM_API_KEY`,
`MEMORY_TIMEZONE` (an IANA name such as `Australia/Melbourne`; default this machine's current
offset), `MEMORY_SESSION_QUIET_MINUTES` (10) and `MEMORY_IDLE_SECONDS` (120).

Settings: `MEMORY_EMBEDDER` is `fastembed` (default), `fake` (hashed words, for wiring tests) or
`off` (full text only); `MEMORY_EMBED_MODEL` picks another fastembed model, which must make
384-dimension vectors. The model is kept in `%LOCALAPPDATA%\aiembodied\memory\models` (`MEMORY_EMBED_CACHE` to move it). If it can't be fetched, search carries on with full text and tries the model again every five minutes.

The HTTP contract is in [API.md](API.md).

## Where the data lives

PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector). All tables are in one
schema (`memory` by default, `MEMORY_SCHEMA`), which the engine creates and migrates on start.

- **Local (default).** `scripts\start.ps1` runs `pgvector/pgvector:pg17` in a container with
  wslc (Docker if wslc is missing; `MEMORY_DB_RUNTIME`), data in the named volume
  `aiembodied-memory-pgdata`, listening on `127.0.0.1:5433`. Port 5432 is left alone because
  majordomo's PostgreSQL in WSL is forwarded there. The password is generated once into
  `%LOCALAPPDATA%\aiembodied\memory\db-password`.
- **Supabase (or any other PostgreSQL).** In the app, add a server of type "Memory database
  (PostgreSQL)" with the project's direct connection or session pooler string (port 5432; the
  transaction pooler doesn't work) and pick it under Memory → Memory database. A password in the
  pasted string is moved to the key store. The engine is told over `PUT /v1/storage` and saves
  the choice in `%LOCALAPPDATA%\aiembodied\memory\engine-settings.json`
  (`MEMORY_SETTINGS_FILE`), so it starts there next time. Enable the `vector` extension in the
  dashboard first if the role can't. Tables go in the `memory` schema, which Supabase's REST API
  doesn't expose. Without the app, set `MEMORY_DATABASE_URL` instead.

  **Moving.** If the new database has no memory yet, the engine copies everything there first and
  answers 503 until it is done (the app queues its writes meanwhile). If it already holds memory,
  it is used as it is: nothing is merged, so switching back and forth between two databases that
  both have data leaves each with its own history. If the old database can't be read, or the copy
  fails, memory stays where it was and `/v1/storage` says why (`move_error`). Asking for another
  move while one is copying gets a 503; the app tries again.
- **Mirror (optional).** Memory → Memory mirror picks a second database that gets a copy of
  everything: new rows by sequence number, changed rows by `updated_at` (facts, sessions,
  summaries, embeddings), and deletes from the tombstones. It pushes every minute
  (`POST /v1/storage/push` pushes now), keeps its place per target in `mirror_state`, and creates
  and migrates the schema there itself. This PC's own database can't be the mirror.

Back up the local database with `pg_dump`:

```powershell
wslc exec aiembodied-memory-db pg_dump -U memory memory > memory-backup.sql
```

## Setup and run

```powershell
cd services\memory
.\scripts\start.ps1          # creates .venv with uv the first time, then starts both
```

By hand:

```powershell
uv venv .venv --python 3.13
uv pip install --python .venv\Scripts\python.exe -e ".[test]"
$env:MEMORY_DATABASE_URL = 'postgresql://memory:<password>@127.0.0.1:5433/memory'
.venv\Scripts\python -m memory_engine serve      # or: migrate
```

`pnpm dev:run` at the repo root starts it with the other local services unless
`MEMORY_AUTOSTART=0`. The app finds it through `MEMORY_SERVICE_URL` (default
`http://127.0.0.1:8194`) and turns it off with `MEMORY_ENABLED=0`; `MEMORY_BRIEF=0` and
`MEMORY_AUTO_RECALL=0` turn off just the brief or auto-recall.

Settings: `MEMORY_DATABASE_URL`, `MEMORY_SCHEMA`, `MEMORY_HOST` / `MEMORY_PORT`, and
`MEMORY_API_TOKEN`, which, when set, makes every `/v1` call need `Authorization: Bearer <token>`.
Set it if the engine listens on anything but localhost.

## Test

The turn logic tests need nothing. The API tests need a PostgreSQL with pgvector; each test uses a
throwaway schema, so the real database is safe:

```powershell
.\scripts\start.ps1 -DatabaseOnly      # prints MEMORY_TEST_DATABASE_URL=...
$env:MEMORY_TEST_DATABASE_URL = '<that url>'
.venv\Scripts\python -m pytest -q
```
