-- One StockLevel row per seeded catalog variant (1..4), 100 on hand at the
-- migration-provisioned `default-warehouse` location, so the public
-- availability read returns a real figure before any inventory consumer has run.
-- The auto-init-on-variant-created path simulates this on the live system; the
-- seed reproduces its effect for `yarn test:seed`, which may run before any RMQ
-- consumer is up.
--
-- quantity_allocated / quantity_reserved start at 0 (no reservation capability
-- yet) so `available = on_hand - allocated - reserved = 100`. `version` is the
-- optimistic-lock token; it starts at 0 (matching `StockLevel.initialAt`).
-- INSERT IGNORE makes a re-run a no-op — the UNIQUE (variant_id, stock_location_id)
-- key rejects a duplicate row, so re-seeding never errors or double-counts.
-- Runs after catalog-product-variant.sql (FK stock_level.variant_id ->
-- product_variant.id); `stock_location` exists from the migration, not a seed.
INSERT IGNORE INTO stock_level
  (variant_id, stock_location_id, quantity_on_hand, quantity_allocated, quantity_reserved, version)
VALUES
  (1, 'default-warehouse', 100, 0, 0, 0),
  (2, 'default-warehouse', 100, 0, 0, 0),
  (3, 'default-warehouse', 100, 0, 0, 0),
  (4, 'default-warehouse', 100, 0, 0, 0);
