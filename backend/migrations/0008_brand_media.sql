-- Marques : nom optionnel (photo seule possible), photo, et adresse /marque/<slug>.
ALTER TABLE brands ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE brands ADD COLUMN image_path TEXT;
DROP INDEX IF EXISTS idx_brands_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_name ON brands (name) WHERE name <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_slug ON brands (slug) WHERE slug <> '';
UPDATE brands SET slug = 'marque-' || id WHERE slug = '';
