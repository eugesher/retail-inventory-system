-- A second, active stock location so Transfer Stock is exercisable on a seeded DB.
-- The migration provisions only `default-warehouse`; a transfer needs a distinct
-- destination, so this seed adds `backup-store` (a `store`-type location, active).
-- The existing `http/inventory.http` ?locationIds example already references a
-- hypothetical `backup-store`, so reusing that id keeps the docs coherent.
--
-- `stock_location` columns: id (caller-assigned VARCHAR(64) PK), name, code (UNIQUE
-- via UC_STOCK_LOCATION_CODE), type ENUM('warehouse','store','dropship-virtual'),
-- active (BOOLEAN). INSERT IGNORE makes a re-run a no-op — the PRIMARY KEY and the
-- UNIQUE code reject a duplicate, so `yarn test:seed` re-runs clean. This file is
-- independent of stock-level.sql (no FK from a stock level seed targets it), but is
-- registered BEFORE it so the destination location exists for any later fixture.
INSERT IGNORE INTO stock_location (id, name, code, type, active)
VALUES ('backup-store', 'Backup Store', 'backup-store', 'store', TRUE);
