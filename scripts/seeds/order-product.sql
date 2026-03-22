-- Order 1: 2 × Alpha (stock 5) + 1 × Beta (stock 3) → all confirmed
INSERT INTO order_product (product_id, order_id, status_id) VALUES (1, 1, 'pending'); -- op-id=1
INSERT INTO order_product (product_id, order_id, status_id) VALUES (1, 1, 'pending'); -- op-id=2
INSERT INTO order_product (product_id, order_id, status_id) VALUES (2, 1, 'pending'); -- op-id=3

-- Order 2: 3 × Gamma (stock 2) → first 2 confirmed, last 1 stays pending
INSERT INTO order_product (product_id, order_id, status_id) VALUES (3, 2, 'pending'); -- op-id=4
INSERT INTO order_product (product_id, order_id, status_id) VALUES (3, 2, 'pending'); -- op-id=5
INSERT INTO order_product (product_id, order_id, status_id) VALUES (3, 2, 'pending'); -- op-id=6

-- Order 3: 1 × Delta (stock 0) → nothing confirmed
INSERT INTO order_product (product_id, order_id, status_id) VALUES (4, 3, 'pending'); -- op-id=7

-- Order 4: already confirmed, must not be re-processed
INSERT INTO order_product (product_id, order_id, status_id) VALUES (1, 4, 'confirmed'); -- op-id=8
