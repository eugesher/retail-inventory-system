INSERT IGNORE INTO cart (id, customer_id, currency, status, version) VALUES
  ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-a000-000000000002', 'USD', 'active', 0);

INSERT INTO cart_line (cart_id, variant_id, quantity, unit_price_snapshot_minor, currency_snapshot)
SELECT '00000000-0000-4000-d000-000000000001', 1, 2, 4999, 'USD'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM cart_line
  WHERE cart_id = '00000000-0000-4000-d000-000000000001' AND variant_id = 1
);
