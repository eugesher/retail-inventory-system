-- Static tax-category classification labels (code + name only, no rate — ADR-026).
-- Fixed ids + INSERT IGNORE keep the seed idempotent: a re-run is a no-op on the
-- primary key. A variant opts in to one of these via the nullable
-- product_variant.tax_category_id FK, attached on demand (PATCH .../tax-category),
-- not wired up here.
INSERT IGNORE INTO tax_category (id, code, name, description) VALUES
  (1, 'STANDARD', 'Standard rate', 'Default classification'),
  (2, 'REDUCED',  'Reduced rate',  'Reduced-band classification'),
  (3, 'EXEMPT',   'Exempt',        'Tax-exempt classification');
