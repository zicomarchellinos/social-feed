# Social Feed

An Instagram-style social app: posts, likes, comments, profiles, direct
messages, and communities — with login/register, a persistent session,
photo uploads in posts and profile avatars, and a pure-white UI.

It also has a super-app style **SF Wallet**: send money between users,
receive via QR, simulated top-ups, and QR payments to other users —
protected by a 6-digit wallet PIN. All money is **demo money in IDR**:
top-ups are simulated and no real money ever moves.

Single service: **Node.js + Express + SQLite**, serving the JSON API and
the static single-page frontend. No build step.

## Run locally

Requires Node.js 22 (better-sqlite3 ships a prebuilt binary for Node 22;
Node 24 has no prebuild, so it would compile from source).

```bash
npm install
npm start
# open http://localhost:3000
```

The server listens on `PORT` (default `3000`) and creates
`data/social-feed.db` on first start. Uploads land in `uploads/`.

## Deploy on Render (free)

1. Push this repo to GitHub.
2. In Render: **New + → Web Service → Build and deploy from a GitHub
   repo**, pick the repo. (Or **New + → Blueprint** and point at
   `render.yaml` — same result.)
3. Render reads `render.yaml`: build `npm install`, start `npm start`,
   Node 22. No environment variables are required.
4. Open the service URL — the app is public immediately.

## Data & storage notes

- **SQLite on a free host is ephemeral.** Render's free instances have an
  ephemeral filesystem: the database file and uploaded photos can be lost
  on a restart or redeploy. That is fine for a demo, but not for real use.
- The later fix is a managed database: move the data layer to Postgres
  (Render offers a free Postgres tier) and uploads to object storage
  (e.g. Cloudflare R2 / S3). The API and frontend would not change —
  only `src/db.js` and the upload storage paths.

## API overview

Auth is a Bearer token (`Authorization: Bearer <token>`); only the
SHA-256 hash of the token is stored, with a 30-day expiry. Passwords are
hashed with bcryptjs. No endpoint returns a password hash or a raw token
except login/register.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Register (display name, email, password ≥ 8 chars) |
| POST | `/api/auth/login` | Log in (generic error for bad email or password) |
| POST | `/api/auth/logout` | Revoke the session |
| GET | `/api/auth/session` | Current user or 401 |
| GET | `/api/users` | People list (for starting DMs) |
| GET | `/api/users/:id` | Profile + post/community counts |
| PATCH | `/api/users/me` | Update display name / bio |
| POST | `/api/users/me/avatar` | Upload avatar (≤ 2 MB image) |
| GET | `/api/users/:id/posts` | A user's posts, newest first |
| GET | `/api/feed` | Main feed, newest first, cursor-paginated |
| POST | `/api/posts` | Create a post (text and/or photo, optional community) |
| DELETE | `/api/posts/:id/photo` | Remove a post's photo (owner only) |
| PUT / DELETE | `/api/posts/:id/like` | Like / unlike (idempotent) |
| GET / POST | `/api/posts/:id/comments` | Comments, oldest first |
| GET / POST | `/api/conversations` | Inbox / find-or-create a 1:1 conversation |
| GET / POST | `/api/conversations/:id/messages` | Thread (members only) |
| GET / POST | `/api/communities` | Browse/search / create (creator auto-joins) |
| POST / DELETE | `/api/communities/:id/join` | Join / leave |
| GET | `/api/communities/:id` | Community details |
| GET | `/api/communities/:id/posts` | Community feed, newest first |
| GET | `/api/wallet` | Wallet balance, PIN status, receive token (lazy-create) |
| GET | `/api/wallet/transactions` | History, newest first (`?filter=all/in/out/deposit`, cursor `?before=`) |
| POST | `/api/wallet/deposits` | Simulated top-up (Rp1.000–Rp5.000.000, demo methods) |
| POST | `/api/wallet/transfers` | Send to a user id or email (needs 6-digit PIN) |
| POST | `/api/wallet/pin` | Set / change the wallet PIN (6 digits, bcrypt-hashed) |
| GET | `/api/wallet/receive-qr` | Static receive payload (`SF-PAY:<token>`, open amount) |
| POST | `/api/wallet/payment-requests` | Fixed-amount request QR (single-use, 15-min expiry) |
| POST | `/api/wallet/resolve-qr` | Resolve an `SF-PAY:` payload before paying |
| POST | `/api/wallet/pay` | Pay a QR payload (fixed amount is authoritative) |

Wallet money is integer IDR only. Money-out endpoints require the wallet
PIN (5 wrong attempts lock the wallet for 15 minutes), use a conditional
debit inside one SQLite transaction, and honor `idempotencyKey` on
deposits, transfers, and payments. QR codes are rendered/scanned with the
vendored `qrcode-generator` and `jsQR` libraries in `public/vendor/` (no
CDN at runtime).

Uploads are validated server-side by MIME type **and** magic bytes, and
served at `/uploads/`.
