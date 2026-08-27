# Supabase + Vercel setup — Stage 1

This covers provisioning only: creating the Supabase project, applying
`schema.sql`, and collecting the environment variables Vercel will need.
**No application code has been changed yet** — `db.js` still reads/writes
`data/db.json` locally. This stage just gets the database and its
credentials ready for the code migration that follows in a later stage.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in (or create an account).
2. Click **New project**.
3. Pick an organization, then set:
   - **Name**: `b2b-swap` (or `b2b-swap-prod` if you plan to also make a separate dev/staging project — see note at the end).
   - **Database password**: generate a strong one and save it somewhere safe (a password manager). It's only needed if you ever connect directly via `psql`/a Postgres connection string — the app itself will use the API keys from step 3, not this password.
   - **Region**: pick the region closest to where your Vercel functions will run (Vercel lets you pin function regions; matching them reduces latency).
4. Click **Create new project** and wait for provisioning to finish (usually 1–2 minutes).

## 2. Apply the schema

1. In the Supabase dashboard for this project, open **SQL Editor** (left sidebar).
2. Click **New query**.
3. Paste the entire contents of `supabase/schema.sql` from this repo.
4. Click **Run**.
5. Confirm it succeeded: open **Table Editor** (left sidebar) and verify four tables now exist — `accounts`, `verification_codes`, `listings`, `deals`.

This is idempotent (`create table if not exists`), so re-running it later is harmless.

## 3. Collect the credentials the app will need

1. In the dashboard, go to **Project Settings → API**.
2. Copy two values:
   - **Project URL** — this becomes `SUPABASE_URL`.
   - **`service_role` secret** (under "Project API keys") — this becomes `SUPABASE_SERVICE_ROLE_KEY`.

**The `service_role` key must never be exposed to the frontend or committed to git.** It bypasses Row Level Security entirely and grants full read/write access to every table. It's used only from server-side code (the Vercel Function), never from `public/*.js`. Do not use the `anon` key for this app — the frontend never talks to Supabase directly, only through our own `/api/*` routes, so there's no reason for the app to hold the `anon` key at all.

## 4. Required Vercel environment variables

Set these in the Vercel dashboard under **Project Settings → Environment Variables** (apply to Production, Preview, and Development environments as appropriate — see note below on using separate Supabase projects per environment).

| Variable | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | Project URL from step 3 | New — required once `db.js` is migrated. |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` secret from step 3 | New — required once `db.js` is migrated. **Server-side only, mark it "Sensitive" in Vercel if that option is available.** |
| `JWT_SECRET` | A long, random string (e.g. `openssl rand -base64 48`) | Already required by `auth-mw.js` today — must be set before this app is live anywhere. |
| `SMTP_HOST` | Your SMTP provider's host | Required for real verification-code emails; without it, `/request-code` logs the code instead of sending it (fine for testing, not for production). |
| `SMTP_USER` | SMTP username | Same as above. |
| `SMTP_PASS` | SMTP password / app password | Same as above. |
| `SMTP_PORT` | e.g. `587` | Optional — defaults to `587` if unset. |
| `SMTP_SECURE` | `true` or `false` | Optional — defaults to `false` if unset. |
| `MAIL_FROM` | e.g. `no-reply@yourdomain.com` | Optional — defaults to `SMTP_USER` if unset. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | From your Twilio console | Optional — only needed for the opt-in SMS trade-confirmation feature. Without these, SMS is skipped/logged, same as today. |

Nothing else changes in Vercel Project Settings yet at this stage (the Root Directory setting and any `api/`/`vercel.json` files come in the code-migration stage).

## 5. One project or several?

For the smallest setup, one Supabase project is enough — reuse the same `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` for local development and for Vercel Preview/Production. If you'd rather keep local testing and real trade data separate, create a second Supabase project (e.g. `b2b-swap-dev`) and re-run steps 2–3 against it, then use its credentials in your local `.env` and in Vercel's **Development**/**Preview** environment variable scope, keeping the first project's credentials scoped to **Production** only.

## What's next

Once this is done and you've confirmed the four tables exist and you have both credential values in hand, the next stage rewrites `db.js` (and its call sites) to use them — that's a separate, later change to application code, not part of this stage.
