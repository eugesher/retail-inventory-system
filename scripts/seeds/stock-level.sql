INSERT IGNORE INTO stock_level
  (variant_id, stock_location_id, quantity_on_hand, quantity_allocated, quantity_reserved, version)
VALUES
  (1, 'default-warehouse', 100, 0, 0, 0),
  (2, 'default-warehouse', 100, 0, 0, 0),
  (3, 'default-warehouse', 100, 0, 0, 0),
  (4, 'default-warehouse', 100, 0, 0, 0);
