-- One example `active` cart for the seeded customer
-- (00000000-0000-4000-a000-000000000002 / customer@example.com), with a single
-- line for seeded catalog variant 1 (AURORA-WARM). It demonstrates the cart shape
-- a `GET /api/cart/:cartId` returns and gives `http/cart.http` a ready fixture to
-- read without first building a cart by hand. The e2e specs do NOT use this row —
-- they create their own carts — so it is purely a development convenience.
--
-- The cart id uses the `...-d000-...` namespace (carts), keeping it distinct from
-- the `a000` (users), `b000` (permissions), and `c000` (roles) prefixes the JS
-- seeds use, so an assertion can reference it by a stable id.
--
-- `unit_price_snapshot_minor` (4999 = $49.99) matches variant 1's seeded open USD
-- price from `price.sql`. A real Add-to-Cart snapshots this from
-- `catalog.price.select` at add-time; the seed copies the same figure so the
-- fixture is internally consistent. `currency_snapshot` matches the cart currency.
--
-- Idempotency: the cart row carries a fixed CHAR(36) primary key and uses INSERT
-- IGNORE, so a re-run is a no-op (the PK rejects the duplicate). The cart_line id
-- is left to AUTO_INCREMENT — it must NOT be hardcoded, because e2e-built carts
-- also draw from that sequence, so a fixed id could collide with a real line on a
-- non-fresh database. Idempotency is instead keyed on the business pair
-- (cart_id, variant_id): the guarded INSERT ... SELECT ... WHERE NOT EXISTS adds
-- the line only when this cart has no line for variant 1 yet, so a re-run inserts
-- nothing — never an error or a duplicate.
--
-- FK ordering: `cart.customer_id -> customer(id)` (seeded by the JS identity pass,
-- which now runs before this file), `cart_line.cart_id -> cart(id)` (this file,
-- cart before line), and `cart_line.variant_id -> product_variant(id)` (seeded by
-- catalog-product-variant.sql). This file is therefore registered after both the
-- customer pass and `catalog-product-variant.sql` + `price.sql`.
INSERT IGNORE INTO cart (id, customer_id, currency, status, version) VALUES
  ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-a000-000000000002', 'USD', 'active', 0);

INSERT INTO cart_line (cart_id, variant_id, quantity, unit_price_snapshot_minor, currency_snapshot)
SELECT '00000000-0000-4000-d000-000000000001', 1, 2, 4999, 'USD'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM cart_line
  WHERE cart_id = '00000000-0000-4000-d000-000000000001' AND variant_id = 1
);
