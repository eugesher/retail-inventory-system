-- Two media assets on the seeded product 1 ('Aurora Desk Lamp'): an image then a
-- video, in `sort_order` 0 then 1, so `GET /api/catalog/products/1/media`
-- returns a real, ordered strip before any media has been attached over the API.
--
--   id 1  image  sort_order 0  front.jpg
--   id 2  video  sort_order 1  demo.mp4
--
-- `media_asset` is POLYMORPHIC: `(owner_type, owner_id)` points at either a
-- `product` or a `product_variant`, with NO foreign key on `owner_id` (an FK
-- can't target two tables). Here both rows are `owner_type = 'product'`,
-- `owner_id = 1`. `uri` is an opaque, already-uploaded reference (never parsed —
-- no upload pipeline); the `cdn.example.com` host is illustrative. `alt_text` is
-- the accessibility caption. `sort_order` is the strip position; the live attach
-- use case appends at `max(sort_order)+1` (counting archived rows so slots stay
-- monotonic), and this seed lays down the first two slots directly.
--
-- Fixed ids keep the assertions stable. INSERT IGNORE makes a re-run a no-op on
-- the PRIMARY KEY. `deleted_at` stays NULL (detach is the `status` flip to
-- 'archived', ADR-025). Runs after catalog-product.sql — `owner_id = 1`
-- logically references product 1 even though no FK enforces it.
INSERT IGNORE INTO media_asset (id, owner_type, owner_id, uri, type, alt_text, sort_order, status)
VALUES (1, 'product', 1, 'https://cdn.example.com/aurora-desk-lamp/front.jpg', 'image', 'Aurora desk lamp, front view', 0, 'active'),
       (2, 'product', 1, 'https://cdn.example.com/aurora-desk-lamp/demo.mp4', 'video', 'Aurora desk lamp demo reel', 1, 'active');
