-- Mounted into the `mysql` service's `/docker-entrypoint-initdb.d/`. The official
-- MySQL image runs every file here ONCE, only on a fresh data volume, AFTER it has
-- created `MYSQL_DATABASE` (`retail_db`) and the `MYSQL_USER` (`retail`) — so the
-- `retail` user already exists when this GRANT runs.
--
-- This provisions the event store's ISOLATED logical database `ris_eventstore`
-- (ADR-034): a separate schema on the same MySQL instance as `retail_db`, kept off the
-- operational tables so the write-heavy event firehose grows independently. `yarn
-- test:infra:down` drops the volume, so `test:infra:up` re-runs this and recreates the
-- schema before `migration:run:eventstore` applies the (later) event-store tables.
CREATE DATABASE IF NOT EXISTS ris_eventstore
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON ris_eventstore.* TO 'retail'@'%';

FLUSH PRIVILEGES;
