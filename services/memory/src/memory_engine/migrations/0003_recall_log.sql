-- What auto-recall put in front of the model on each turn, with its scores, so the thresholds
-- can be tuned and the Memory panel can show why a reply said what it said. Never indexed.
-- No foreign key: the turn's session may still be queued in the app when recall runs.
CREATE TABLE recall_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    session_id  uuid,
    query       text NOT NULL,
    items       jsonb NOT NULL DEFAULT '[]',   -- [{id, kind, score, similarity}]
    reason      text                           -- why nothing was injected, when nothing was
);
CREATE INDEX recall_log_session_idx ON recall_log (session_id);
CREATE INDEX recall_log_at_idx ON recall_log (at);
