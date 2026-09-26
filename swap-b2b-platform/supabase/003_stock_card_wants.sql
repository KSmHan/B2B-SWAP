-- =====================================================================
-- B2B SWAP — "What do you need in return?" on stock cards.
-- Run once in the Supabase SQL editor after 002_stock_cards.sql. Safe to re-run.
--
-- Optional free text from the upload form (e.g. "plywood, packaging" or
-- "cash"). The chain search uses it as the card owner's wish; empty means
-- the owner is open to offers. Uploads keep working before this runs —
-- the field is simply not saved until the column exists.
-- =====================================================================
alter table stock_cards add column if not exists wants text not null default '';
notify pgrst, 'reload schema';
