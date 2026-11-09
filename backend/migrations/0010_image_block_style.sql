-- Style d'affichage d'une bannière : photo simple ou grande image plein écran.
ALTER TABLE image_blocks ADD COLUMN style TEXT NOT NULL DEFAULT 'photo';
