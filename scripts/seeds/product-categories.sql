-- Classifies the seeded product 1 ('Aurora Desk Lamp') into two seeded
-- categories: electronics (id 1) and its child phones (id 2). This makes the
-- browse-by-category reads non-empty out of the box —
-- `GET /api/catalog/categories/electronics/products?includeDescendants=true`
-- returns product 1 via the direct membership AND via the descendant `phones`.
--
-- `product_categories` is the BARE N↔M join (composite PRIMARY KEY
-- (product_id, category_id), no surrogate id, no timestamps) — there is no
-- TypeORM entity; the reclassify use case maintains it with parameterized
-- INSERT IGNORE / DELETE, and this seed reproduces an attach.
--
-- INSERT IGNORE makes a re-run a no-op: the composite PK rejects a duplicate
-- pair. Runs AFTER catalog-product.sql (FK product_id -> product.id) and
-- category.sql (FK category_id -> category.id) — both must already be seeded.
INSERT IGNORE INTO product_categories (product_id, category_id)
VALUES (1, 1), (1, 2);
