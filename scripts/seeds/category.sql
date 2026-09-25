INSERT IGNORE INTO category (id, name, slug, parent_id, path, sort_order, status)
VALUES (1, 'Electronics', 'electronics', NULL, '/electronics', 0, 'active'),
       (2, 'Phones', 'phones', 1, '/electronics/phones', 0, 'active'),
       (3, 'Apparel', 'apparel', NULL, '/apparel', 1, 'active');
