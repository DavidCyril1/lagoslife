/**
 * Cloudflare Worker — Lagos Life Gift
 * - Serves static assets
 * - Proxies /api/* to upstream (hides real API from browser)
 * - Verifies Cloudflare Turnstile before starting gifts
 */

const UPSTREAM = 'https://apis.davidcyril.name.ng';
const MAX_AMOUNT = 10_000_000;
const DEFAULT_AMOUNT = 1_000_000;

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

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  // POST /api/gift — start gift (requires Turnstile)
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
    return json(data, upstreamRes.status);
  }

  // GET /api/job/:id — poll job status (no secret needed; job ids are unguessable enough)
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

  // GET /api/job?id=
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

    // CORS preflight for API
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
        // Allow same-origin only ideally, but add CORS for flexibility
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', url.origin);
        return new Response(res.body, { status: res.status, headers });
      } catch (err) {
        return json({ success: false, error: 'Proxy error' }, 502);
      }
    }

    // Static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Assets binding missing', { status: 503 });
  },
};
