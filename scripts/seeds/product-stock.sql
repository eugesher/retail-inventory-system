-- Products 1-3 get initial stock; Product 4 (Delta) gets none → balance = 0
INSERT INTO product_stock (product_id, storage_id, action_id, quantity) VALUES (1, 'head-warehouse', 'manual-stock-update', 5);
INSERT INTO product_stock (product_id, storage_id, action_id, quantity) VALUES (2, 'head-warehouse', 'manual-stock-update', 3);
INSERT INTO product_stock (product_id, storage_id, action_id, quantity) VALUES (3, 'head-warehouse', 'manual-stock-update', 2);
