-- The raw record (sessions, messages) and the searchable index built from it.
-- Everything lives in the "memory" schema, which the engine puts first on its search_path.
-- On Supabase that keeps the tables out of the public REST API, which only exposes "public".

CREATE EXTENSION IF NOT EXISTS vector;

-- One conversation. All agents (characters) share one memory; `agent` is for filtering.
CREATE TABLE sessions (
    id          uuid PRIMARY KEY,
    seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    agent       text NOT NULL DEFAULT 'unknown',
    channel     text NOT NULL DEFAULT 'unknown',   -- voice | text | phone | ...
    title       text,
    location    text,                              -- where the agent was, when known
    started_at  timestamptz NOT NULL,
    ended_at    timestamptz,
    meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_started_idx ON sessions (started_at DESC);

-- Every message verbatim: user, assistant, and tool calls with their results.
-- IDs come from the client, so a retried write is a no-op.
CREATE TABLE messages (
    id            uuid PRIMARY KEY,
    seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    session_id    uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    role          text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    speaker       text,                            -- who spoke, once voice identification exists
    location      text,
    content       text NOT NULL,
    tool          jsonb,                           -- {name, arguments, ok} on tool rows
    created_at    timestamptz NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    content_hash  text NOT NULL,
    private       boolean NOT NULL DEFAULT false,
    meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX messages_session_time_idx ON messages (session_id, created_at, seq);
CREATE INDEX messages_time_idx ON messages (created_at);

-- The units retrieval searches. Phase 1 writes turns (a user message, the tool calls and the
-- reply that follow it); summaries and facts join later. Rebuildable from the tables above.
CREATE TABLE recall_index (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    kind          text NOT NULL,                   -- turn | session | day | week | month | fact
    source_id     uuid NOT NULL,                   -- the turn's first message, a summary, a fact
    session_id    uuid REFERENCES sessions (id) ON DELETE CASCADE,
    agent         text,
    period_start  timestamptz NOT NULL,
    period_end    timestamptz NOT NULL,
    text          text NOT NULL,
    message_ids   uuid[] NOT NULL DEFAULT '{}',
    importance    real NOT NULL DEFAULT 0.5,
    private       boolean NOT NULL DEFAULT false,
    search        tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    embedding     vector(384),
    embed_model   text,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, source_id)
);
CREATE INDEX recall_index_search_idx ON recall_index USING gin (search);
CREATE INDEX recall_index_period_idx ON recall_index (period_start);
CREATE INDEX recall_index_session_idx ON recall_index (session_id);
CREATE INDEX recall_index_embedding_idx ON recall_index USING hnsw (embedding vector_cosine_ops);

-- Deleted rows, so a delete can reach a mirror.
CREATE TABLE tombstones (
    seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name  text NOT NULL,
    row_id      uuid NOT NULL,
    deleted_at  timestamptz NOT NULL DEFAULT now()
);
