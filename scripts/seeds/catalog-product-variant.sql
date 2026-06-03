INSERT IGNORE INTO product_variant (id, product_id, sku, gtin, option_values, weight_g, dimensions_mm, status)
VALUES (1, 1, 'AURORA-WARM', NULL, '{"color":"warm-white"}', 800, '{"l":300,"w":120,"h":120}', 'active'),
       (2, 1, 'AURORA-COOL', NULL, '{"color":"cool-white"}', 800, '{"l":300,"w":120,"h":120}', 'active'),
       (3, 2, 'NIMBUS-BLACK', NULL, '{"color":"black"}', 12000, '{"l":650,"w":650,"h":1100}', 'active'),
       (4, 2, 'NIMBUS-GREY',  NULL, '{"color":"grey"}',  12000, '{"l":650,"w":650,"h":1100}', 'active');
