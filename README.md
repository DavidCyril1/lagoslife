# Lagos Life Gift

Free **1,000,000** Lagos Life cash gift site.

Users enter their Lagos Life username → async gift job → poll until completed.

**UI:** Neo-brutalist style from [DC-Labs](https://github.com/DavidCyril1/DC-Labs) + hamster wheel loader.

**API:** `https://apis.davidcyril.name.ng/lagoslife/gift`

---

## Deploy on Cloudflare Workers

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Or with Cloudflare Pages (drag-and-drop `index.html` or connect this repo).

---

## Local preview

```bash
npx wrangler dev
# open http://localhost:8787
```

---

## Flow

1. `GET /lagoslife/gift?to=USERNAME` → `{ job_id }`
2. Poll `GET /job/{job_id}` every ~2.5s
3. Show success / error

No API key required on these public routes.

---

Powered by [David Cyril Tech API](https://apis.davidcyril.name.ng)
