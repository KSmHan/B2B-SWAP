# B2B SWAP — deployable server

A real Node.js/Express backend + static frontend for the B2B SWAP platform.
Accounts and listings live on the server (not in the browser), so a
company's account, listings, and trade history are the same on every
device — the earlier prototype stored everything in browser localStorage,
which is why different devices/browsers looked like different companies.
This version fixes that.

## What's real vs. simulated

| Feature | Status |
|---|---|
| Accounts, listings, "My listings" isolation | **Real** — stored server-side in `data/db.json`, works from any device |
| AI matching / trade chain search | **Real** — runs server-side in `matching.js` |
| Email notifications | **Real**, once you set `SMTP_*` in `.env` (any provider) |
| SMS notifications | **Real**, once you set `TWILIO_*` in `.env` (optional, sent only if a phone number is on file) |
| Email verification codes (sign-in) | **Real** email once SMTP is configured; otherwise logged to the server console (dev/testing only) |

Nothing needs to be "turned on" in code to go from demo to real — the
same code path runs either way. It only depends on whether the `.env`
credentials are present, checked automatically at boot (see console
output when the server starts).

## Local setup

```bash
npm install
cp .env.example .env      # then edit .env — see below
npm start                 # serves on http://localhost:3000
```

With no `SMTP_*`/`TWILIO_*` set, the app runs fully — you can create
accounts, publish listings, search chains, and confirm trades. Emails/SMS
are logged to the console instead of sent, and in `NODE_ENV=development`
the verification code is also returned directly in the API response so
you can log in without a real email provider while testing locally.
**`devCode` is never returned when `NODE_ENV=production`.**

## Connecting real email (recommended first — it's free/cheap and simple)

Any SMTP provider works. Easiest options:

- **Gmail**: enable 2FA on the sending account, create an
  [App Password](https://myaccount.google.com/apppasswords), use it as
  `SMTP_PASS` with `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`,
  `SMTP_SECURE=true`.
- **SendGrid / Postmark / Resend / AWS SES**: create an API key, use
  their SMTP relay credentials — each provides exact host/port/user/pass
  values in their dashboard.

Once set, restart the server. `/api/health` will report
`"emailConfigured": true`, and sign-in verification codes + trade
notifications will actually be delivered.

## Connecting real SMS (optional)

1. Create a [Twilio](https://www.twilio.com) account and buy a phone
   number capable of SMS.
2. Put the Account SID, Auth Token, and the number into `.env` as
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
3. For real US business-texting volume, register an
   [A2P 10DLC campaign](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)
   in the Twilio console — low-volume testing works before that's
   approved.
4. Twilio bills **you** (the platform), not the person receiving the
   text — budget for it if you expect real trade volume (roughly
   $0.008–0.01 per US SMS plus a small monthly number/campaign fee at
   the time of writing; check Twilio's current pricing).

## Deploying

This is a plain Node process — it runs on any host that runs Node 18+:
Render, Railway, Fly.io, a DigitalOcean/Linode/EC2 VPS, or your own
server. There's no native/compiled dependency, so `npm install` is fast
and portable everywhere.

Minimal steps on any of those platforms:

1. Push this `server/` folder to a Git repo.
2. Set the build command to `npm install` and the start command to
   `npm start`.
3. Set the environment variables from `.env.example` in the platform's
   dashboard (never commit `.env` itself).
4. **Persistent disk**: `data/db.json` must live on a persistent volume.
   Render/Railway/Fly all support attaching a small persistent disk —
   mount it at `/app/data` (or wherever this repo lands) so the file
   survives deploys and restarts. On a plain VPS this is automatic since
   the disk is already persistent.
5. Put a reverse proxy / platform-managed TLS in front of the app (all
   of the above platforms do this for you) so the site is served over
   HTTPS — required for cookies to work reliably and for phone/SMS
   compliance in most jurisdictions.

### Scaling beyond this file-based store

`data/db.json` is intentionally simple so the project runs anywhere
with zero setup. Every read/write goes through `db.js` — if you outgrow
a single JSON file (concurrent write contention, large record counts,
need for multiple server instances), replace the internals of `db.js`
with a real database (Postgres is the natural choice) without touching
any route file, since they only call the functions `db.js` exports.

## Project structure

```
server.js            Express app entry point
matching.js           Seed catalog + AI chain-matching engine (shared logic)
db.js                 File-backed data store (accounts, listings, deals)
mailer.js              Nodemailer wrapper (real email)
sms.js                 Twilio wrapper (real SMS)
auth-mw.js             JWT session cookie handling
lib/account-helpers.js Shared account/notification-requirement helpers
routes/
  auth.js               /api/auth/*   — email verification, profile, session
  listings.js            /api/listings/* — catalog, publish, my listings
  agent.js                /api/agent/search — AI trade-chain search
  deals.js                 /api/deals/confirm — notify a trade chain
public/                Static frontend (plain HTML/CSS/JS, no build step)
data/db.json            Created automatically on first run
```

## Security notes for a production launch

- Set a long, random `JWT_SECRET` (see the comment in `.env.example`).
- Set `NODE_ENV=production` so dev-only behaviors (returning the
  verification code in the API response) are fully disabled.
- The app already applies `helmet`, rate limiting on `/api/*` (tighter
  on auth endpoints), and httpOnly/secure session cookies.
- Consider adding CAPTCHA on `request-code` if you see abuse.
- Add a privacy policy / SMS consent language before collecting real
  phone numbers at scale — required in most jurisdictions for business
  texting (TCPA in the US).
