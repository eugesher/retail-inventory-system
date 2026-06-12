-- A small seeded category hierarchy so the public browse + tree reads return a
-- real answer before any category has been created over the API. Two roots
-- (`/electronics`, `/apparel`) and one child (`/electronics/phones`):
--
--   id 1  electronics            path /electronics           (root)
--   id 2  phones    parent 1     path /electronics/phones    (child of electronics)
--   id 3  apparel                path /apparel               (root)
--
-- `path` is the MATERIALIZED PATH (the full root-to-self slug chain) — a child's
-- path is `<parent.path>/<slug>`, a root's is `/<slug>`. It is stored, not
-- derived, so it MUST be written consistently with `parent_id` here (the live
-- create/reparent use cases compute it; the seed reproduces their output).
-- `sort_order` orders siblings in the navigation; both roots are independent so
-- electronics (0) sorts before apparel (1).
--
-- Fixed ids keep `product-categories.sql` and the e2e/.http assertions stable.
-- INSERT IGNORE makes a re-run a no-op: the PRIMARY KEY (and UC_CATEGORY_SLUG
-- UNIQUE) reject a duplicate, so re-seeding never errors or double-inserts.
-- `created_at`/`updated_at` default at the column; `deleted_at` stays NULL
-- (soft-delete is the `status` flip, ADR-025). Runs after
-- catalog-product-variant.sql is not required for `category` itself (no FK to
-- product), but it is grouped with the catalog seeds and precedes
-- product-categories.sql, which references these ids.
INSERT IGNORE INTO category (id, name, slug, parent_id, path, sort_order, status)
VALUES (1, 'Electronics', 'electronics', NULL, '/electronics', 0, 'active'),
       (2, 'Phones', 'phones', 1, '/electronics/phones', 0, 'active'),
       (3, 'Apparel', 'apparel', NULL, '/apparel', 1, 'active');
