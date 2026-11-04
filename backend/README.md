# Aura Skin backend

Axum + SQLite backend for the static Aura Skin storefront. It provides customer registration and login, administrator sessions, product management, and local JPEG/PNG/WebP uploads. It does not use Shopify.

## Run locally

Create a hashed administrator password (the plaintext is never stored or put on the command line), then put the hash in `backend/.env`:

```sh
read -rsp "Administrator password: " PW; echo
printf '%s\n' "$PW" | cargo run --release -- hash-password
unset PW
```

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` in `backend/.env` (see `.env.example`; keep the hash in single quotes), then start the server:

```sh
cargo run
```

The server listens on `http://127.0.0.1:8080`. Open `/login` to sign in or `/register` to create a customer account. Administrators sign in at `/ikrame`, which shows the admin login and then the dashboard; `/admin` no longer exists. The first launch creates `store.db` and the configured administrator. Set `STATIC_DIR`, `DATABASE_URL`, and `PRODUCT_UPLOAD_DIR` when running from a different directory.

Local HTTP testing needs `COOKIE_SECURE=false`; the default is `true`, so cookies are only sent over HTTPS (browsers still accept them on `localhost`).

Before starting the backend, build the local storefront from the repository root with `python3 build_modele_boutique.py`.

## Social sign-in

`/login` and `/register` are public routes. Google and Facebook sign-in buttons appear after their OAuth app credentials are set in `backend/.env`; register each exact callback URL (`/auth/google/callback` or `/auth/facebook/callback`) in the provider console. Never commit `.env`. Google addresses must be provider-verified, and a social provider is not automatically linked to an existing password account. Instagram consumer sign-in is not supported by the current official Instagram Login product, which targets professional accounts.

## Security notes

- Passwords are hashed with Argon2id, including the administrator password (`ADMIN_PASSWORD_HASH`). Session tokens are random, stored only as SHA-256 hashes, and sent in HttpOnly, SameSite=Strict, Secure cookies.
- Login is rate-limited per IP (30 failures per 15 minutes) and per account (5 failures per 15 minutes, then a 15-minute lockout). Registration allows 10 attempts per IP per hour. Analytics events allow 120 per IP per minute. Limits are kept in memory and reset when the server restarts.
- Registration returns the same response whether or not the email already exists, so accounts cannot be enumerated. Login spends the same time on unknown emails.
- Public registration always creates a customer account. Admin access is provisioned only through `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` at startup. The startup check refuses an `ADMIN_EMAIL` that already belongs to a customer account.
- Behind a reverse proxy, set `TRUST_PROXY=true` and have the proxy set `X-Real-IP` so rate limits apply per visitor. Without it, forwarded headers are ignored.
- Responses for `/ikrame` (the admin area), `/login`, `/register`, `/product/`, and `/api/` use a strict Content-Security-Policy with no inline scripts. The storefront still uses inline scripts from the theme, so its policy keeps `'unsafe-inline'`. All responses send HSTS and a Permissions-Policy.
- The SQLite database and its journal files are set to mode 600 on startup.
- The bootstrap `admin` account is the owner. It can create or revoke `manager` accounts. Managers can edit products and upload images, but server-side role checks deny them analytics, manager administration, and both exports.
- Product writes and image uploads require an administrator session and a same-origin request. Image uploads are limited to 5 MB and JPEG, PNG, or WebP signatures.
- The owner can export products as `products.csv` and customer email addresses as `customer-emails.csv`; the latter uses an `Email` column suitable for Google/Gmail Contacts import. These exports do not call the Gmail API.
- Use HTTPS in deployment and set `COOKIE_SECURE=true`. Keep the database and administrator credentials out of the web root and backups access-controlled.

## Analytics

Visitors are asked to opt in before tracking starts and can change that choice through the privacy preferences link in the footer. The admin dashboard then shows page views, internal link clicks, 25/50/75/100% scroll milestones, and popular pages/links for 7, 30, or 90 days. A visitor is an anonymous browser-tab session, so this is an estimate, not a count of verified people. The database stores only a random session ID, page paths, click paths, scroll milestones, and timestamps; it does not store IP addresses, emails, page text, or query-string values.

This backend intentionally does not process payments. Connect a payment provider before accepting online payments.