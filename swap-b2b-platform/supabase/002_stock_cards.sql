-- =====================================================================
-- B2B SWAP — stock cards (one-file stock list uploads)
--
-- Run once in the Supabase SQL editor AFTER schema.sql. Safe to re-run.
--
-- A "stock card" is a company + contact person that published its whole
-- stock list by uploading one file (Excel / CSV / Word / PDF). No account
-- is required; the uploader gets a private manage link instead (only its
-- SHA-256 hash is stored here). Every row of the file becomes one
-- stock_items row, auto-classified into a material type (aluminum,
-- copper, steel, mdf, plywood, …; see lib/materials.js for the keys).
--
-- Same access model as schema.sql: RLS enabled with no policies, so only
-- the server's service-role key can read or write.
-- =====================================================================

create extension if not exists pg_trgm;

create table if not exists stock_cards (
  id                 text primary key,
  company            text not null,
  contact_name       text not null,
  email              text not null,
  phone              text not null,
  file_name          text,
  file_format        text,
  file_size          integer,
  file_path          text,                 -- latest file's object path in the "stock-files" bucket
  files              jsonb not null default '[]'::jsonb,   -- every uploaded file: [{ name, path, format, size, items, uploadedAt }]
  item_count         integer not null default 0,
  categories         jsonb not null default '{}'::jsonb,   -- { "aluminum": 12, "mdf": 3, … }
  status             text not null default 'live',
  manage_token_hash  text not null,
  created_at         timestamptz not null default now()
);
alter table stock_cards enable row level security;
-- For databases where an earlier version of this script already ran.
alter table stock_cards add column if not exists files jsonb not null default '[]'::jsonb;
create index if not exists stock_cards_status_created_idx on stock_cards (status, created_at desc);

create table if not exists stock_items (
  id           bigint generated always as identity primary key,
  card_id      text not null references stock_cards(id) on delete cascade,
  position     integer not null default 0,
  category     text not null,
  title        text not null,
  qty          text,
  unit         text,
  price        text,
  specs        text,
  search_text  text generated always as (lower(title || ' ' || coalesce(specs, ''))) stored,
  created_at   timestamptz not null default now()
);
alter table stock_items enable row level security;
create index if not exists stock_items_card_idx on stock_items (card_id, position);
create index if not exists stock_items_category_idx on stock_items (category);
create index if not exists stock_items_search_trgm_idx on stock_items using gin (search_text gin_trgm_ops);

-- Live item counts per material type, for the catalogue's filter chips.
-- security_invoker keeps the view behind the same RLS as its tables.
create or replace view stock_category_counts with (security_invoker = true) as
  select i.category, count(*)::int as n
  from stock_items i join stock_cards c on c.id = i.card_id
  where c.status = 'live'
  group by i.category;

-- Private bucket for the original uploaded files (served via short-lived signed URLs).
insert into storage.buckets (id, name, public, file_size_limit)
values ('stock-files', 'stock-files', false, 10485760)
on conflict (id) do nothing;

-- Newer Supabase projects no longer grant the API roles access to tables
-- created in SQL automatically, which makes every /api/cards call fail with
-- "permission denied for table stock_cards". Only the server's service role
-- needs access (RLS keeps anon/authenticated out regardless).
grant select, insert, update, delete on table stock_cards, stock_items to service_role;
grant select on table stock_category_counts to service_role;
grant usage, select on all sequences in schema public to service_role;
notify pgrst, 'reload schema';
