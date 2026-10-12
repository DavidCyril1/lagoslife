/**
 * Cloudflare Worker — Lagos Life Gift
 * Login with fixed bot account → send money (no auto-register)
 */

const UPSTREAM = 'https://apis.davidcyril.name.ng';
const MAX_AMOUNT = 10_000_000;
const DEFAULT_AMOUNT = 1_000_000;
const MIN_AMOUNT = 100;

// Defaults; can override via wrangler vars / secrets
const DEFAULT_BOT_USER = 'davidcyriltech';
const DEFAULT_BOT_PASS = '85200555';

function cooldownSeconds(amount) {
  if (amount >= 10_000_000) return 6 * 60 * 60;
  if (amount >= 7_500_000) return 4 * 60 * 60;
  if (amount >= 5_000_000) return 2 * 60 * 60;
  if (amount >= 2_500_000) return 60 * 60;
  return 15 * 60;
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
  await cache.put(
    key,
    new Response(JSON.stringify({ until, amount, secs }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${secs}`,
      },
    })
  );
}

async function botLogin(env) {
  const user = env.BOT_USERNAME || DEFAULT_BOT_USER;
  const pass = env.BOT_PASSWORD || DEFAULT_BOT_PASS;
  const url = new URL(`${UPSTREAM}/lagoslife/login`);
  url.searchParams.set('username', user);
  url.searchParams.set('password', pass);
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!data.success || !data.result?.session) {
    throw new Error(data.message || data.error || 'Bot login failed');
  }
  return {
    session: data.result.session,
    username: data.result.username || user,
  };
}

async function botSend(session, to, amount, note) {
  const url = new URL(`${UPSTREAM}/lagoslife/send`);
  url.searchParams.set('session', session);
  url.searchParams.set('to', to);
  url.searchParams.set('amount', String(amount));
  if (note) url.searchParams.set('note', note);
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  return { httpStatus: res.status, data };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  // POST /api/gift — login bot + send (sync, no register)
  if ((path === '/gift' || path === '/lagoslife/gift') && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const to = (body.to || '').trim().replace(/^@/, '');
    const amount = Math.min(
      Math.max(parseInt(body.amount, 10) || DEFAULT_AMOUNT, MIN_AMOUNT),
      MAX_AMOUNT
    );
    const note = (body.note || 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴠɪᴅ ᴄʏʀɪʟ ᴛᴇᴄʜ').toString();
    const token = body.cf_turnstile_response || body.token || '';

    if (!to) {
      return json({ success: false, error: 'Username (to) is required' }, 400);
    }

    const secret = env.TURNSTILE_SECRET;
    if (!secret) {
      return json({ success: false, error: 'Server misconfigured (missing Turnstile secret)' }, 500);
    }

    const ip = request.headers.get('CF-Connecting-IP') || '';

    const cd = await getCooldown(ip);
    if (cd && cd.until && Date.now() < cd.until) {
      const left = Math.ceil((cd.until - Date.now()) / 1000);
      return json(
        {
          success: false,
          error: `Cooldown active after a large claim. Try again in ${formatRemaining(left)}.`,
          cooldown: { remaining: left, until: cd.until },
        },
        429
      );
    }

    const ok = await verifyTurnstile(token, secret, ip);
    if (!ok) {
      return json({ success: false, error: 'Turnstile verification failed. Please try again.' }, 403);
    }

    try {
      const bot = await botLogin(env);
      const { data } = await botSend(bot.session, to, amount, note);

      if (!data.success) {
        return json(
          {
            success: false,
            error: data.message || data.error || 'Send failed',
            result: data.result || null,
          },
          data.status && data.status >= 400 ? data.status : 400
        );
      }

      await setCooldown(ip, amount);

      // Shape similar to completed job for frontend
      return json({
        success: true,
        result: {
          status: 'completed',
          progress: 100,
          result: {
            sent: true,
            amount,
            to,
            note,
            from: bot.username,
            sendResult: data.result || data,
          },
        },
      });
    } catch (e) {
      return json({ success: false, error: e.message || 'Gift failed' }, 502);
    }
  }

  // Keep job poll for backwards compatibility (noop style)
  if (path.startsWith('/job/') || path.startsWith('/jobs/') || path === '/job' || path === '/jobs') {
    return json({
      success: false,
      error: 'Jobs disabled — gifts are sent instantly via login. Use POST /api/gift only.',
    }, 410);
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
      } catch {
        return json({ success: false, error: 'Proxy error' }, 502);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Assets binding missing', { status: 503 });
  },
};
