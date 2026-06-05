-- One open (valid_to IS NULL) USD price per seeded catalog variant (1..4), so a
-- published product is consistent and the single-applicable read returns a seeded
-- answer. valid_from is a FIXED past instant (never NOW()) so the seed is
-- deterministic and idempotent across runs. amount_minor is integer minor units
-- (cents): 4999 = $49.99 for the lamp variants, 19999 = $199.99 for the chair
-- variants. open_scope_key is a STORED generated column — it is deliberately
-- absent from the column list (MySQL computes it; an insert that names it would
-- error). INSERT IGNORE makes a re-run a no-op on the primary key; the UNIQUE
-- open_scope_key independently rejects a second open row for the same scope.
-- Runs after catalog-product-variant.sql (FK price.variant_id -> product_variant.id).
INSERT IGNORE INTO price (id, variant_id, currency, amount_minor, valid_from, valid_to, priority) VALUES
  (1, 1, 'USD', 4999,  '2020-01-01 00:00:00', NULL, 0),
  (2, 2, 'USD', 4999,  '2020-01-01 00:00:00', NULL, 0),
  (3, 3, 'USD', 19999, '2020-01-01 00:00:00', NULL, 0),
  (4, 4, 'USD', 19999, '2020-01-01 00:00:00', NULL, 0);
