/**
 * Cloudflare Worker — Lagos Life Gift
 * - Serves static assets
 * - Proxies /api/* (hides real upstream)
 * - Turnstile verification
 * - Amount-based IP cooldown (Cache API)
 */

const UPSTREAM = 'https://apis.davidcyril.name.ng';
const MAX_AMOUNT = 10_000_000;
const DEFAULT_AMOUNT = 1_000_000;

/** Cooldown seconds by amount tier (server-side, per IP) */
function cooldownSeconds(amount) {
  if (amount >= 10_000_000) return 6 * 60 * 60;  // 10M  → 6h
  if (amount >= 7_500_000)  return 4 * 60 * 60;  // 7.5M → 4h
  if (amount >= 5_000_000)  return 2 * 60 * 60;  // 5M   → 2h
  if (amount >= 2_500_000)  return 60 * 60;      // 2.5M → 1h
  return 15 * 60;                                 // 1M   → 15m
}

function formatRemaining(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

async function verifyTurnstile(token, secret, ip) {
  if (!token || !secret) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  return data.success === true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function getCooldown(ip) {
  if (!ip) return null;
  const cache = caches.default;
  const key = new Request(`https://cooldown.internal/ip/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  if (!hit) return null;
  try {
    return await hit.json();
  } catch {
    return null;
  }
}

async function setCooldown(ip, amount) {
  if (!ip) return;
  const secs = cooldownSeconds(amount);
  const until = Date.now() + secs * 1000;
  const cache = caches.default;
  const key = new Request(`https://cooldown.internal/ip/${encodeURIComponent(ip)}`);
  const body = JSON.stringify({ until, amount, secs });
  await cache.put(
    key,
    new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${secs}`,
      },
    })
  );
  return { until, secs };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  if ((path === '/gift' || path === '/lagoslife/gift') && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const to = (body.to || '').trim();
    const amount = Math.min(
      Math.max(parseInt(body.amount, 10) || DEFAULT_AMOUNT, 1),
      MAX_AMOUNT
    );
    const token = body.cf_turnstile_response || body.token || '';

    if (!to) {
      return json({ success: false, error: 'Username (to) is required' }, 400);
    }

    const secret = env.TURNSTILE_SECRET;
    if (!secret) {
      return json({ success: false, error: 'Server misconfigured (missing Turnstile secret)' }, 500);
    }

    const ip = request.headers.get('CF-Connecting-IP') || '';

    // Server cooldown check
    const cd = await getCooldown(ip);
    if (cd && cd.until && Date.now() < cd.until) {
      const left = Math.ceil((cd.until - Date.now()) / 1000);
      return json({
        success: false,
        error: `Cooldown active after a large claim. Try again in ${formatRemaining(left)}.`,
        cooldown: { remaining: left, until: cd.until },
      }, 429);
    }

    const ok = await verifyTurnstile(token, secret, ip);
    if (!ok) {
      return json({ success: false, error: 'Turnstile verification failed. Please try again.' }, 403);
    }

    const upstreamUrl = new URL(`${UPSTREAM}/lagoslife/gift`);
    upstreamUrl.searchParams.set('to', to);
    upstreamUrl.searchParams.set('amount', String(amount));

    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const data = await upstreamRes.json().catch(() => ({}));

    // Apply cooldown after a successful job start (large amounts especially)
    if (data.success && data.result?.job_id) {
      await setCooldown(ip, amount);
    }

    return json(data, upstreamRes.status);
  }

  if (path.startsWith('/job/') || path.startsWith('/jobs/')) {
    const jobId = path.split('/').filter(Boolean).pop();
    if (!jobId || jobId.length < 8) {
      return json({ success: false, error: 'Invalid job id' }, 400);
    }
    const upstreamRes = await fetch(`${UPSTREAM}/job/${encodeURIComponent(jobId)}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await upstreamRes.json().catch(() => ({}));
    return json(data, upstreamRes.status);
  }

  if (path === '/job' || path === '/jobs') {
    const jobId = url.searchParams.get('id');
    if (!jobId) return json({ success: false, error: 'Missing id' }, 400);
    const upstreamRes = await fetch(`${UPSTREAM}/job/${encodeURIComponent(jobId)}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await upstreamRes.json().catch(() => ({}));
    return json(data, upstreamRes.status);
  }

  return json({ success: false, error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api')) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname.startsWith('/api')) {
      try {
        const res = await handleApi(request, env);
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', url.origin);
        return new Response(res.body, { status: res.status, headers });
      } catch (err) {
        return json({ success: false, error: 'Proxy error' }, 502);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Assets binding missing', { status: 503 });
  },
};
