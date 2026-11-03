-- How far a mirror (a second database, such as a Supabase project) has been sent. One row per
-- mirror, named by its host, database and user (never its password). Only the source keeps it.
CREATE TABLE mirror_state (
    target        text PRIMARY KEY,
    marks         jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_push_at  timestamptz,
    last_error    text
);
