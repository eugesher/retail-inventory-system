-- The channel-consent record for the seeded acceptance customer
-- (`customer@example.com`, id `00000000-0000-4000-a000-000000000002`) at the
-- capability defaults: transactional email ON, both marketing channels OFF, the
-- baseline `default-7-years` retention policy.
--
-- `consent_record` is 1:1 with `customer` keyed on the CHAR(36) `customer_id` PK
-- (FK -> customer(id) ON DELETE CASCADE), so this row can only be inserted AFTER
-- the identity pass has seeded the customer. The identity rows are seeded
-- programmatically (JS) before any of the SQL seed files run, so this file's
-- position among them is free; it is registered after the retail `cart.sql`
-- fixture for tidiness.
--
-- The row is not strictly required for the seeded customer to have consent — an
-- ABSENT row already resolves to these very defaults (the notification
-- consent-gate reads absent-means-defaults). It exists so the persistence and the
-- read path are both exercised against a concrete stored row, and so the seeded
-- customer has an explicit, inspectable consent state.
--
-- INSERT IGNORE on the `customer_id` PK makes a re-run a no-op: the second seed
-- collides on the primary key and is ignored, so re-seeding never errors or
-- overwrites a consent state a test may have mutated. `updated_at` defaults at the
-- column.
INSERT IGNORE INTO consent_record
  (customer_id, transactional_email, marketing_email, marketing_sms, data_retention_policy)
VALUES
  ('00000000-0000-4000-a000-000000000002', 1, 0, 0, 'default-7-years');
