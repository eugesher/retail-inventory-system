INSERT IGNORE INTO media_asset (id, owner_type, owner_id, uri, type, alt_text, sort_order, status)
VALUES (1, 'product', 1, 'https://cdn.example.com/aurora-desk-lamp/front.jpg', 'image', 'Aurora desk lamp, front view', 0, 'active'),
       (2, 'product', 1, 'https://cdn.example.com/aurora-desk-lamp/demo.mp4', 'video', 'Aurora desk lamp demo reel', 1, 'active');
