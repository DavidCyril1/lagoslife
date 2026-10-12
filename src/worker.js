/**
 * Lagos Life Gift Worker
 * Fixed bot login + send · strict API · multi-layer cooldowns
 */

const UPSTREAM = 'https://apis.davidcyril.name.ng';
const MAX_AMOUNT = 1_000_000;
const DEFAULT_AMOUNT = 1_000_000;
const MIN_AMOUNT = 100;

const DEFAULT_BOT_USER = 'davidcyriltech';
const DEFAULT_BOT_PASS = '85200555';

/** Per-IP cooldown after a successful claim (seconds) */
const IP_COOLDOWN_SECS = 15 * 60;
/** Per recipient username cooldown (seconds) — hard to bypass by changing IP */
const USER_COOLDOWN_SECS = 24 * 60 * 60;
/** Global daily send cap (sum of amounts) */
const GLOBAL_DAILY_CAP = 50_000_000;
/** Soft rate-limit: max gift attempts per IP per minute */
const IP_ATTEMPT_LIMIT = 8;
const IP_ATTEMPT_WINDOW = 60;
/** Cached bot session lifetime */
const SESSION_TTL_SECS = 20 * 60;

const CODES = {
  INVALID_BODY: 'INVALID_BODY',
  MISSING_TO: 'MISSING_TO',
  SELF_SEND: 'SELF_SEND',
  FORBIDDEN: 'FORBIDDEN',
  CAPTCHA: 'CAPTCHA',
  COOLDOWN_IP: 'COOLDOWN_IP',
  COOLDOWN_USER: 'COOLDOWN_USER',
  DAILY_CAP: 'DAILY_CAP',
  RATE_LIMIT: 'RATE_LIMIT',
  BUSY: 'BUSY',
  SEND_FAILED: 'SEND_FAILED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  MISCONFIG: 'MISCONFIG',
  NOT_FOUND: 'NOT_FOUND',
};

function formatRemaining(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function apiJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function err(code, message, status, extra = {}) {
  return apiJson({ success: false, code, error: message, ...extra }, status);
}

async function cacheGet(urlKey) {
  const hit = await caches.default.match(new Request(urlKey));
  if (!hit) return null;
  try {
    return await hit.json();
  } catch {
    return null;
  }
}

async function cachePut(urlKey, data, maxAgeSecs) {
  await caches.default.put(
    new Request(urlKey),
    new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${Math.max(1, maxAgeSecs)}`,
      },
    })
  );
}

async function verifyTurnstile(token, secret, ip) {
  if (!token || !secret) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

/** Same-origin only — blocks external scrapers calling /api */
function assertSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer') || '';
  const host = url.host;

  if (origin) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  } else if (referer) {
    try {
      if (new URL(referer).host !== host) return false;
    } catch {
      return false;
    }
  } else {
    // No Origin/Referer — typical of curl/scripts
    return false;
  }

  const xrw = (request.headers.get('X-Requested-With') || '').toLowerCase();
  if (xrw !== 'lagoslife-gift') return false;

  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.includes('application/json')) return false;

  return true;
}

async function checkIpCooldown(ip) {
  if (!ip) return null;
  const data = await cacheGet(`https://cd.internal/ip/${encodeURIComponent(ip)}`);
  if (data?.until && Date.now() < data.until) return data;
  return null;
}

async function setIpCooldown(ip) {
  if (!ip) return null;
  const secs = IP_COOLDOWN_SECS;
  const until = Date.now() + secs * 1000;
  await cachePut(`https://cd.internal/ip/${encodeURIComponent(ip)}`, { until, secs }, secs);
  return { until, secs };
}

async function checkUserCooldown(username) {
  const key = username.toLowerCase();
  const data = await cacheGet(`https://cd.internal/user/${encodeURIComponent(key)}`);
  if (data?.until && Date.now() < data.until) return data;
  return null;
}

async function setUserCooldown(username) {
  const key = username.toLowerCase();
  const secs = USER_COOLDOWN_SECS;
  const until = Date.now() + secs * 1000;
  await cachePut(`https://cd.internal/user/${encodeURIComponent(key)}`, { until, secs }, secs);
  return { until, secs };
}

async function getDailyUsage() {
  const day = utcDayKey();
  const data = await cacheGet(`https://cd.internal/daily/${day}`);
  return { day, used: Number(data?.used) || 0 };
}

async function addDailyUsage(amount) {
  const day = utcDayKey();
  const cur = await getDailyUsage();
  const used = cur.used + amount;
  const ttl = secondsUntilUtcMidnight() + 3600;
  await cachePut(`https://cd.internal/daily/${day}`, { used, day }, ttl);
  return used;
}

async function bumpIpAttempts(ip) {
  if (!ip) return { count: 0, limited: false };
  const key = `https://cd.internal/attempts/${encodeURIComponent(ip)}`;
  const data = (await cacheGet(key)) || { count: 0, start: Date.now() };
  const elapsed = Date.now() - (data.start || Date.now());
  let count = data.count || 0;
  let start = data.start || Date.now();
  if (elapsed > IP_ATTEMPT_WINDOW * 1000) {
    count = 0;
    start = Date.now();
  }
  count += 1;
  await cachePut(key, { count, start }, IP_ATTEMPT_WINDOW);
  return { count, limited: count > IP_ATTEMPT_LIMIT };
}

/** Session cache — bot is NOT permanently logged in; we reuse session ~20m */
async function getBotSession(env) {
  const botUser = env.BOT_USERNAME || DEFAULT_BOT_USER;
  const cached = await cacheGet(`https://cd.internal/botsession/${encodeURIComponent(botUser)}`);
  if (cached?.session && cached.exp && Date.now() < cached.exp) {
    return { session: cached.session, username: cached.username || botUser, cached: true };
  }

  const pass = env.BOT_PASSWORD || DEFAULT_BOT_PASS;
  const url = new URL(`${UPSTREAM}/lagoslife/login`);
  url.searchParams.set('username', botUser);
  url.searchParams.set('password', pass);

  let res;
  try {
    res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('LOGIN_UPSTREAM');
  }
  const data = await res.json().catch(() => ({}));
  if (!data.success || !data.result?.session) {
    throw new Error(data.message || data.error || 'LOGIN_FAILED');
  }

  const session = data.result.session;
  const username = data.result.username || botUser;
  await cachePut(
    `https://cd.internal/botsession/${encodeURIComponent(botUser)}`,
    { session, username, exp: Date.now() + SESSION_TTL_SECS * 1000 },
    SESSION_TTL_SECS
  );
  return { session, username, cached: false };
}

async function clearBotSession(env) {
  const botUser = env.BOT_USERNAME || DEFAULT_BOT_USER;
  // Overwrite with expired entry
  await cachePut(
    `https://cd.internal/botsession/${encodeURIComponent(botUser)}`,
    { session: null, exp: 0 },
    1
  );
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

async function handleGift(request, env) {
  if (request.method !== 'POST') {
    return err(CODES.FORBIDDEN, 'Method not allowed', 405);
  }

  if (!assertSameOrigin(request)) {
    return err(CODES.FORBIDDEN, 'Request blocked', 403);
  }

  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    return err(CODES.MISCONFIG, 'Service temporarily unavailable', 503);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const attempts = await bumpIpAttempts(ip);
  if (attempts.limited) {
    return err(
      CODES.RATE_LIMIT,
      'Too many requests. Please wait a moment and try again.',
      429,
      { retryAfter: IP_ATTEMPT_WINDOW }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return err(CODES.INVALID_BODY, 'Invalid request', 400);
  }

  const to = String(body.to || '')
    .trim()
    .replace(/^@/, '');
  const amount = DEFAULT_AMOUNT; // fixed 1M — ignore client amount
  const note = 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴠɪᴅ ᴄʏʀɪʟ ᴛᴇᴄʜ';
  const token = body.cf_turnstile_response || body.token || '';

  if (!to || to.length < 2 || to.length > 32 || !/^[a-zA-Z0-9_]+$/.test(to)) {
    return err(CODES.MISSING_TO, 'Enter a valid Lagos Life username', 400);
  }

  const botUser = (env.BOT_USERNAME || DEFAULT_BOT_USER).toLowerCase();
  if (to.toLowerCase() === botUser) {
    return err(CODES.SELF_SEND, 'This username cannot receive gifts here', 400);
  }

  // IP cooldown
  const ipCd = await checkIpCooldown(ip);
  if (ipCd) {
    const left = Math.ceil((ipCd.until - Date.now()) / 1000);
    return err(
      CODES.COOLDOWN_IP,
      `Please wait before claiming again. Available in ${formatRemaining(left)}.`,
      429,
      { cooldown: { remaining: left, until: ipCd.until, scope: 'ip' } }
    );
  }

  // Per-username cooldown (survives IP change)
  const userCd = await checkUserCooldown(to);
  if (userCd) {
    const left = Math.ceil((userCd.until - Date.now()) / 1000);
    return err(
      CODES.COOLDOWN_USER,
      `This account already claimed recently. Next claim available in ${formatRemaining(left)}.`,
      429,
      { cooldown: { remaining: left, until: userCd.until, scope: 'user' } }
    );
  }

  // Global daily cap
  const daily = await getDailyUsage();
  if (daily.used + amount > GLOBAL_DAILY_CAP) {
    const left = secondsUntilUtcMidnight();
    return err(
      CODES.DAILY_CAP,
      'Today’s gift allocation is fully reserved. Distribution resumes after midnight UTC.',
      503,
      { cooldown: { remaining: left, until: Date.now() + left * 1000, scope: 'daily' } }
    );
  }

  const okTs = await verifyTurnstile(token, secret, ip);
  if (!okTs) {
    return err(CODES.CAPTCHA, 'Security check failed. Please complete the verification and try again.', 403);
  }

  try {
    let bot = await getBotSession(env);
    let { data } = await botSend(bot.session, to, amount, note);

    // Session may have expired — re-login once
    if (
      !data.success &&
      /session|login|auth|unauthorized|expired/i.test(String(data.message || data.error || ''))
    ) {
      await clearBotSession(env);
      bot = await getBotSession(env);
      ({ data } = await botSend(bot.session, to, amount, note));
    }

    if (!data.success) {
      const msg = data.message || data.error || 'Transfer could not be completed';
      // Map upstream congestion to friendly busy
      if (/timeout|busy|rate|limit|try again/i.test(msg)) {
        return err(
          CODES.BUSY,
          'Gift service is under high load right now. Please try again in a few minutes.',
          503,
          { retryAfter: 120 }
        );
      }
      return err(CODES.SEND_FAILED, msg, 400);
    }

    await setIpCooldown(ip);
    await setUserCooldown(to);
    await addDailyUsage(amount);

    const ipUntil = Date.now() + IP_COOLDOWN_SECS * 1000;
    const userUntil = Date.now() + USER_COOLDOWN_SECS * 1000;

    return apiJson({
      success: true,
      code: 'OK',
      result: {
        status: 'completed',
        progress: 100,
        result: {
          sent: true,
          amount,
          to,
        },
      },
      cooldown: {
        remaining: IP_COOLDOWN_SECS,
        until: ipUntil,
        userUntil,
        scope: 'ip',
      },
    });
  } catch (e) {
    const m = e.message || '';
    if (m === 'LOGIN_UPSTREAM' || m === 'LOGIN_FAILED' || /login/i.test(m)) {
      return err(
        CODES.BUSY,
        'Gift service is temporarily unavailable. Please try again shortly.',
        503,
        { retryAfter: 180 }
      );
    }
    return err(CODES.BUSY, 'Gift service is under high load right now. Please try again in a few minutes.', 503);
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  // Only one public mutation endpoint
  if (path === '/gift' || path === '/lagoslife/gift') {
    return handleGift(request, env);
  }

  // Everything else: opaque 404 (no hints)
  return err(CODES.NOT_FOUND, 'Not found', 404);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // robots.txt
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { 'Content-Type': 'text/plain', ...SECURITY_HEADERS },
      });
    }

    // Block obvious scraper probes on API
    if (url.pathname.startsWith('/api')) {
      // No CORS wildcard — browser same-origin only
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      }
      try {
        const res = await handleApi(request, env);
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
        // Do not allow cross-origin reads
        headers.delete('Access-Control-Allow-Origin');
        return new Response(res.body, { status: res.status, headers });
      } catch {
        return err(CODES.BUSY, 'Service unavailable', 503);
      }
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
      headers.set('Cache-Control', 'public, max-age=300');
      return new Response(res.body, { status: res.status, headers });
    }
    return new Response('Not available', { status: 503, headers: SECURITY_HEADERS });
  },
};
