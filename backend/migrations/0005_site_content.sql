CREATE TABLE IF NOT EXISTS site_content (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'image')),
    page TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS site_content_page_idx ON site_content(kind, page);
