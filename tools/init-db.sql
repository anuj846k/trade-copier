-- Runs once, on the first `docker compose up`, against the `trade_copier`
-- database. Everything here is development-only convenience.
--
-- The integration test suite refuses to run unless TEST_DATABASE_URL points at
-- a database whose name ends in `_test` (see apps/api/test/helpers/database.ts),
-- so this database exists purely to make that guard easy to satisfy.

CREATE DATABASE trade_copier_test OWNER trade_copier;

-- The `citext` extension would let us use case-insensitive email columns, but
-- emails are normalised in application code (lower-cased on write) so the
-- column stays `text` and the migration set has no extension requirements.
