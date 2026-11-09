-- Coding work: what the coding runner did for Echo, kept so Echo remembers it. One row per task,
-- rewritten when the task changes (for instance its pull request is merged). Each row is also
-- indexed in recall_index (kind 'coding_task', source = 'coding'), so search can find it and the
-- brief can list recent work. Like the Home Assistant tables, this is not mirrored yet, and the
-- mirror skips recall_index rows whose source is not 'conversation'.

CREATE TABLE coding_tasks (
    task_id         text PRIMARY KEY,
    index_id        uuid NOT NULL,                  -- recall_index.source_id for this task
    workspace_id    text NOT NULL,
    workspace_name  text NOT NULL,
    title           text NOT NULL,
    outcome         text NOT NULL CHECK (outcome IN ('done', 'failed', 'cancelled', 'discarded')),
    pr_url          text,
    pr_state        text,
    branch          text,
    files_changed   jsonb NOT NULL DEFAULT '[]',
    added           integer NOT NULL DEFAULT 0,
    removed         integer NOT NULL DEFAULT 0,
    review_flags    jsonb NOT NULL DEFAULT '[]',
    summary         text NOT NULL DEFAULT '',
    model           text,
    provider        text,
    agent           text,
    started_at      timestamptz,
    finished_at     timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coding_tasks_finished_idx ON coding_tasks (finished_at DESC);
