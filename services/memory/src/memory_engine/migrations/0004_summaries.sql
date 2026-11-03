-- Summaries made in the background by an LLM: one per conversation once it has gone quiet,
-- then one per closed calendar day, week (Monday start) and month, each from the level below.
-- Each is mirrored into recall_index (kind = 'session' | 'day' | 'week' | 'month').
CREATE TABLE summaries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    kind          text NOT NULL CHECK (kind IN ('session', 'day', 'week', 'month')),
    session_id    uuid REFERENCES sessions (id) ON DELETE CASCADE,
    period_start  timestamptz NOT NULL,
    period_end    timestamptz NOT NULL,
    title         text,
    text          text NOT NULL,
    topics        text[] NOT NULL DEFAULT '{}',
    -- The newest message (session) or child summary the summary saw, so it is redone when
    -- something later arrives (a queued message) or a source is deleted.
    covered_seq   bigint NOT NULL DEFAULT 0,
    model         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX summaries_session_idx ON summaries (session_id) WHERE kind = 'session';
CREATE UNIQUE INDEX summaries_period_idx ON summaries (kind, period_start) WHERE kind <> 'session';
CREATE INDEX summaries_period_range_idx ON summaries (period_start, period_end);
