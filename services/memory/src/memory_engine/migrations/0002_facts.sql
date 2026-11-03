-- Durable facts and preferences ("Kevin prefers wslc over Docker"). Written by the agent's
-- remember tool, by Kevin, and (later) extracted from conversations. A changed fact is a new
-- row that supersedes the old one; the old one is kept.
CREATE TABLE facts (
    id                  uuid PRIMARY KEY,
    seq                 bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    text                text NOT NULL,
    subject             text,
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retracted')),
    pinned              boolean NOT NULL DEFAULT false,
    author              text NOT NULL DEFAULT 'agent',      -- agent | user | extractor
    agent               text,                                -- which character noted it
    session_id          uuid REFERENCES sessions (id) ON DELETE SET NULL,
    source_message_ids  uuid[] NOT NULL DEFAULT '{}',
    supersedes          uuid REFERENCES facts (id) ON DELETE SET NULL,
    private             boolean NOT NULL DEFAULT false,
    reviewed_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facts_status_idx ON facts (status, pinned);
CREATE INDEX facts_subject_idx ON facts (lower(subject));

-- Vectors are only compared within one model.
CREATE INDEX recall_index_embed_model_idx ON recall_index (embed_model);
CREATE INDEX recall_index_unembedded_idx ON recall_index (seq) WHERE embedding IS NULL;
