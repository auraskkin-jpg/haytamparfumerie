CREATE TABLE IF NOT EXISTS analytics_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page_view', 'link_click', 'scroll')),
    path TEXT NOT NULL,
    target TEXT,
    depth INTEGER,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_created_kind_idx ON analytics_events(created_at, kind);
CREATE INDEX IF NOT EXISTS analytics_session_kind_idx ON analytics_events(session_id, kind);
CREATE INDEX IF NOT EXISTS analytics_path_idx ON analytics_events(path, kind);