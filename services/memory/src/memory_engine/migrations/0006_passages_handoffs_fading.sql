-- Long texts are also embedded in overlapping windows of a few sentences (recall_passages), so
-- an exchange or summary can be found by what it says past its opening. Passages are made from
-- the index row and rebuilt with it; they are not mirrored (a takeover re-makes them).
-- passages_model says which model made a row's passages; it is not mirrored either.
ALTER TABLE recall_index ADD COLUMN passages_model text;

CREATE TABLE recall_passages (
    index_id     uuid NOT NULL REFERENCES recall_index (id) ON DELETE CASCADE,
    part         integer NOT NULL,
    text         text NOT NULL,
    embedding    vector(384) NOT NULL,
    embed_model  text NOT NULL,
    PRIMARY KEY (index_id, part)
);
CREATE INDEX recall_passages_embedding_idx ON recall_passages USING hnsw (embedding vector_cosine_ops);

-- Which model wrote a fact (the conversation model for the agent, the summary model for the
-- extractor; empty for Kevin's own). And how much it is used: a fact recalled in a conversation
-- is strengthened once per conversation, and one that is never used fades out of the brief
-- (it stays searchable).
ALTER TABLE facts ADD COLUMN model text;
ALTER TABLE facts ADD COLUMN recall_count integer NOT NULL DEFAULT 0;
ALTER TABLE facts ADD COLUMN last_recalled_at timestamptz;
ALTER TABLE facts ADD COLUMN last_recalled_session uuid;

-- A note the agent leaves for its next conversation, in its own words: where things stand.
-- One per conversation (a new one replaces it); the newest from another conversation goes in
-- the brief whole. Also indexed (kind 'handoff') so it can be searched.
CREATE TABLE handoffs (
    id          uuid PRIMARY KEY,
    seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    agent       text,
    model       text,
    text        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id)
);
CREATE INDEX handoffs_updated_idx ON handoffs (updated_at DESC);
