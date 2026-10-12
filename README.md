# Lagos Life Gift

Sends cash from a **fixed bot account** (login + transfer). No auto-register.

Default bot: configured in Worker env (`BOT_USERNAME` / `BOT_PASSWORD`).

## Flow

1. User completes Turnstile + enters recipient username  
2. `POST /api/gift` → Worker logs in as bot → `/lagoslife/send`  
3. Instant result (no job polling)

## Deploy

```bash
npm install
npx wrangler deploy
```

Bot balance must cover payouts. Min send ₦100 (Lagos Life rule).
