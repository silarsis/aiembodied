# Memory engine

Long-term memory for a chat agent. Every message is kept in PostgreSQL, forever unless you delete
it, and can be found again by time, by subject and by relevance. It is a stand-alone service with
an HTTP API: aiembodied is one client, and nothing here depends on it. The design is in the
[eternal memory design doc](https://claude.ai/artifact/VKbfzVfg91QQjFexz8eDr1).

What exists so far (phase 1):

- **The record.** Sessions and every message verbatim (user, assistant, tool calls with their
  results), with client-made IDs so retried writes are harmless.
- **Turns.** Each user message, the tool calls and the reply after it, indexed together for
  full-text search. Turns are worked out from time order, so a message that arrives late still
  lands in the right turn.
- **Browse and search.** Sessions by date range, a session's messages, full-text search with
  date, agent and privacy filters.
- **Forget.** Delete a session or a message, with everything indexed from it. Deletes are recorded
  as tombstones so a future mirror can follow them.

Still to come: embeddings and hybrid search, facts, the session brief and auto-recall, background
summaries by day, week and month, and Supabase mirroring.

The HTTP contract is in [API.md](API.md).

## Where the data lives

PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector). All tables are in one
schema (`memory` by default, `MEMORY_SCHEMA`), which the engine creates and migrates on start.

- **Local (default).** `scripts\start.ps1` runs `pgvector/pgvector:pg17` in a container with
  wslc (Docker if wslc is missing; `MEMORY_DB_RUNTIME`), data in the named volume
  `aiembodied-memory-pgdata`, listening on `127.0.0.1:5433`. Port 5432 is left alone because
  majordomo's PostgreSQL in WSL is forwarded there. The password is generated once into
  `%LOCALAPPDATA%\aiembodied\memory\db-password`.
- **Supabase (or any other PostgreSQL).** Set `MEMORY_DATABASE_URL` to the project's direct
  connection or session pooler (port 5432; the transaction pooler doesn't work), and the start
  script runs no container. Enable the `vector` extension in the dashboard first if the role
  can't. Tables go in the `memory` schema, which Supabase's REST API doesn't expose.

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
`http://127.0.0.1:8194`) and turns it off with `MEMORY_ENABLED=0`.

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
