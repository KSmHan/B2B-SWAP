-- =====================================================================
-- B2B SWAP — Supabase/Postgres schema
--
-- Replaces the file-backed store in db.js (data/db.json) for deployment
-- on Vercel, where the local filesystem is not a reliable place to keep
-- state between serverless invocations. Mirrors emptyState() in db.js
-- 1:1 — accounts, verification_codes, listings, deals.
--
-- Run this once in the Supabase SQL editor (or via `supabase db push`)
-- against a fresh project before the app code is switched over to talk
-- to Supabase.
--
-- All access from the app goes through the service role key on the
-- server only (never exposed to the frontend), so these tables enable
-- Row Level Security with no policies attached: the service role
-- bypasses RLS entirely, while every other key (including the anon
-- key, which this app never uses) is denied by default. This costs
-- nothing today and is free protection if a key is ever misconfigured.
-- =====================================================================

-- ---------------- Accounts ----------------
-- id values are generated in application code with the same nanoid
-- alphabet/length already used by db.js today (customAlphabet
-- '0123456789abcdefghijklmnopqrstuvwxyz', 12) — kept as plain text so
-- the ID scheme does not have to change as part of this migration.
create table if not exists accounts (
  id          text primary key,
  email       text not null unique,
  phone       text,
  company     text,
  verified    boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table accounts enable row level security;

-- ---------------- Verification codes ----------------
-- One row per email (matches today's codes[email] = {code, expiresAt}
-- object). A new request-code overwrites any existing row for that
-- email (upsert on the primary key); checkCode deletes the row on a
-- successful verify, same as the current in-memory behavior.
create table if not exists verification_codes (
  email       text primary key,
  code        text not null,
  expires_at  timestamptz not null
);

alter table verification_codes enable row level security;

-- ---------------- Listings ----------------
-- User-published listings only. Seed/demo listings continue to live
-- in-memory in matching.js and are never written here — is_seed is
-- kept for schema parity with db.js's row shape but should always be
-- false for rows actually stored in this table.
create table if not exists listings (
  id                 text primary key,
  cat                text,
  title              text not null,
  qty                text,
  condition          text,
  description        text,
  price              numeric,
  specs              text,
  tags               jsonb,
  wants_text         text,
  want_tokens        jsonb,
  want_cat           text,
  owner              text,
  phone              text,
  email              text,
  region             text,
  pickup_location    text,
  cash_ok            boolean not null default false,
  cash_range         text,
  status             text not null default 'live',
  owner_account_id   text not null references accounts(id) on delete cascade,
  is_seed            boolean not null default false,
  created_at         timestamptz not null default now()
);

alter table listings enable row level security;

-- Supports GET /api/listings (status = 'live' filter) and
-- GET /api/listings/mine (listingsByOwner).
create index if not exists listings_status_idx on listings (status);
create index if not exists listings_owner_account_id_idx on listings (owner_account_id);

-- ---------------- Deals log ----------------
create table if not exists deals (
  id                     text primary key,
  initiator_account_id   text references accounts(id) on delete set null,
  initiator_company      text,
  chain_listing_ids      jsonb,
  created_at             timestamptz not null default now()
);

alter table deals enable row level security;

create index if not exists deals_initiator_account_id_idx on deals (initiator_account_id);
