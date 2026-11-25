-- Agents and time: what an avatar means to do (intentions), the flows it built for itself, and
-- whether it is asleep. The workflows service (Temporal) runs the flows and the timers; memory
-- keeps the what and why, so it survives a restart of Temporal. All three are kept per avatar
-- (avatar_id is the avatar's id, such as 'echo'). Like the Home Assistant and coding tables, they
-- are not mirrored yet.

-- Goals, intentions, promises, watches, reminders and wake-ups. A row can point at the workflow
-- that carries it out (workflow_id) and at the flow template and parameters it was started with.
CREATE TABLE intentions (
    id                 uuid PRIMARY KEY,
    avatar_id          text NOT NULL,
    kind               text NOT NULL CHECK (kind IN ('goal', 'intention', 'promise', 'watch', 'reminder', 'wakeup')),
    text               text NOT NULL,
    why                text,
    status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done', 'dropped')),
    parent_id          uuid REFERENCES intentions (id) ON DELETE SET NULL,
    workflow_id        text,
    template           text,
    params             jsonb,
    due_at             timestamptz,
    origin_message_id  text,
    outcome            text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intentions_avatar_status_idx ON intentions (avatar_id, status);
CREATE INDEX intentions_workflow_idx ON intentions (workflow_id) WHERE workflow_id IS NOT NULL;

-- Flows an avatar built itself: a definition (steps) and what starts it. Saving again bumps
-- `version`; every saved version is kept in agent_flow_versions. Deleting only switches the flow
-- off and sets deleted_at, so its history stays.
CREATE TABLE agent_flows (
    avatar_id     text NOT NULL,
    name          text NOT NULL,
    description   text NOT NULL DEFAULT '',
    version       integer NOT NULL DEFAULT 1,
    definition    jsonb NOT NULL,
    trigger       jsonb NOT NULL DEFAULT '{"kind": "manual"}',
    enabled       boolean NOT NULL DEFAULT true,
    deleted_at    timestamptz,
    last_run_at   timestamptz,
    last_outcome  text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (avatar_id, name)
);

CREATE TABLE agent_flow_versions (
    avatar_id   text NOT NULL,
    name        text NOT NULL,
    version     integer NOT NULL,
    definition  jsonb NOT NULL,
    trigger     jsonb NOT NULL,
    saved_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (avatar_id, name, version)
);

-- Whether an avatar is asleep, and since when it has been awake (the app keeps this up to date).
CREATE TABLE agent_state (
    avatar_id      text PRIMARY KEY,
    asleep         boolean NOT NULL DEFAULT false,
    awake_since    timestamptz,
    last_sleep_at  timestamptz,
    last_wake_at   timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
