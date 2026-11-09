-- Images publiées par l'admin sur une page (accueil ou une page du site), en haut ou en bas.
CREATE TABLE IF NOT EXISTS image_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page TEXT NOT NULL,
    position TEXT NOT NULL DEFAULT 'top',
    image_path TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    alt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_blocks_page ON image_blocks (page);
