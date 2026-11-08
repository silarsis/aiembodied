-- Home Assistant: what the house did, kept by the same engine but apart from conversation memory.
-- Rows in recall_index that come from Home Assistant carry source = 'home_assistant'; every
-- search, the brief, auto-recall and the summaries leave them out unless asked for.
--
-- None of these tables is in the mirror yet (mirror.py's TABLES), and the mirror skips
-- recall_index rows whose source is not 'conversation'. That is a later step.

ALTER TABLE recall_index ADD COLUMN source text NOT NULL DEFAULT 'conversation';
CREATE INDEX recall_index_source_idx ON recall_index (source);

-- One row per Home Assistant installation. The access token is never stored here.
CREATE TABLE homes (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    url           text NOT NULL,
    connected_at  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The entities being watched, and what the listener last saw of each.
CREATE TABLE ha_entities (
    home_id        text REFERENCES homes (id) ON DELETE CASCADE,
    entity_id      text,
    name           text,
    area           text,
    domain         text NOT NULL,
    device_class   text,
    unit           text,
    class          text NOT NULL CHECK (class IN ('alert', 'state', 'numeric', 'ignore')),
    deadband       double precision,              -- overrides the default for the device class
    last_state     text,
    last_value     double precision,              -- the last value kept as a reading
    last_kept_at   timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (home_id, entity_id)
);

-- alert and change: a state that changed. reading: a number worth keeping (pruned after a while).
CREATE TABLE ha_events (
    id           uuid PRIMARY KEY,
    seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    home_id      text NOT NULL,
    entity_id    text NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('alert', 'change', 'reading')),
    at           timestamptz NOT NULL,
    state        text,
    old_state    text,
    value        double precision,
    attributes   jsonb NOT NULL DEFAULT '{}',
    received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ha_events_entity_idx ON ha_events (home_id, entity_id, at);
CREATE INDEX ha_events_at_idx ON ha_events (at);

-- Hourly rollup of every numeric value seen, kept or not (mean = sum / n).
CREATE TABLE ha_readings (
    home_id    text NOT NULL,
    entity_id  text NOT NULL,
    hour       timestamptz NOT NULL,
    n          integer NOT NULL,
    min        double precision,
    max        double precision,
    sum        double precision,
    last       double precision,
    PRIMARY KEY (home_id, entity_id, hour)
);
