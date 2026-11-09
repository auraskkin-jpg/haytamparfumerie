-- Options produit : badge « Promo » et badge « Épuisé ».
ALTER TABLE products ADD COLUMN promo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN sold_out INTEGER NOT NULL DEFAULT 0;
