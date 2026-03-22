-- 3 pending orders (full, partial, no-stock) + 1 already confirmed
INSERT INTO `order` (customer_id, status_id) VALUES (1, 'pending');   -- id=1: full confirmation
INSERT INTO `order` (customer_id, status_id) VALUES (1, 'pending');   -- id=2: partial confirmation
INSERT INTO `order` (customer_id, status_id) VALUES (1, 'pending');   -- id=3: no stock available
INSERT INTO `order` (customer_id, status_id) VALUES (1, 'confirmed'); -- id=4: already confirmed
