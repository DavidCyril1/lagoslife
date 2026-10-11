# Lagos Life Gift

Free Lagos Life cash gift site (up to **10M**).

- Neo-brutalist UI (DC-Labs style) + hamster loader
- **Cloudflare Turnstile** bot protection
- Real API is **never exposed** — browser only talks to `/api/*` on this Worker

## Deploy

```bash
npm install
npx wrangler login

# REQUIRED — set Turnstile secret (never commit this)
npx wrangler secret put TURNSTILE_SECRET
# paste: 0x4AAAAAAFUGVg5-ebfebaFIzqeF8tKxHgI

npx wrangler deploy
```

## Local

```bash
npx wrangler secret put TURNSTILE_SECRET   # once
npx wrangler dev
```

## API (same-origin only)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/gift` | Start gift — body: `{ to, amount?, cf_turnstile_response }` |
| `GET`  | `/api/job/:id` | Poll job status |

Upstream API is proxied server-side. Max amount: **10,000,000**.
