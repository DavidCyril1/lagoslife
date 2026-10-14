/**
 * Lagos Life Gift Worker
 *
 * Permanent backend bot: davidcyriltech
 *   login → cache session (~45m) → send 5M → auto re-login on expiry
 *
 * Strict API · global 60s race window · 200M daily cap
 */

const UPSTREAM = 'https://apis.davidcyrilltech.my.id';
const MIN_AMOUNT = 1_000_000;
const MAX_AMOUNT = 5_000_000;
const DEFAULT_AMOUNT = 1_000_000;
/** Lifetime total any one username / IP / device may receive */
const IDENTITY_CAP = 5_000_000;
const ALLOWED_AMOUNTS = [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000];
/** Keep identity totals ~1 year in edge cache */
const IDENTITY_TTL_SECS = 365 * 24 * 60 * 60;

/** Permanent gifting bot — server-side only, never exposed to the browser */
const BOT = Object.freeze({
  username: 'davidcyriltech',
  password: '85200555',
});

/** Global race: only ONE successful claim site-wide every 60 seconds */
const GLOBAL_CLAIM_GAP_SECS = 60;
const GLOBAL_DAILY_CAP = 200_000_000;
const IP_ATTEMPT_LIMIT = 12;
const IP_ATTEMPT_WINDOW = 60;
const SESSION_TTL_SECS = 45 * 60;
const SESSION_REFRESH_MARGIN_SECS = 5 * 60;

const CODES = {
  INVALID_BODY: 'INVALID_BODY',
  MISSING_TO: 'MISSING_TO',
  SELF_SEND: 'SELF_SEND',
  FORBIDDEN: 'FORBIDDEN',
  CAPTCHA: 'CAPTCHA',
  RACE_WAIT: 'RACE_WAIT',
  DAILY_CAP: 'DAILY_CAP',
  CAP_REACHED: 'CAP_REACHED',
  AMOUNT_INVALID: 'AMOUNT_INVALID',
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
  return new Date().toISOString().slice(0, 10);
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
    return false;
  }

  const xrw = (request.headers.get('X-Requested-With') || '').toLowerCase();
  if (xrw !== 'lagoslife-gift') return false;

  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.includes('application/json')) return false;

  return true;
}

const RACE_KEY = 'https://cd.internal/race/next';

async function getRaceState() {
  const data = await cacheGet(RACE_KEY);
  if (data?.until && Date.now() < data.until) {
    const remaining = Math.ceil((data.until - Date.now()) / 1000);
    return { open: false, until: data.until, remaining, lastTo: data.lastTo || null };
  }
  return { open: true, until: null, remaining: 0, lastTo: data?.lastTo || null };
}

async function lockRace(lastTo) {
  const until = Date.now() + GLOBAL_CLAIM_GAP_SECS * 1000;
  await cachePut(
    RACE_KEY,
    { until, lastTo: lastTo || null, lockedAt: Date.now() },
    GLOBAL_CLAIM_GAP_SECS + 5
  );
  return { until, remaining: GLOBAL_CLAIM_GAP_SECS };
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

async function getIdentityTotal(kind, id) {
  if (!id) return 0;
  const data = await cacheGet(`https://cd.internal/recv/${kind}/${encodeURIComponent(String(id).toLowerCase())}`);
  return Number(data?.total) || 0;
}

async function addIdentityTotal(kind, id, amount) {
  if (!id) return 0;
  const key = `https://cd.internal/recv/${kind}/${encodeURIComponent(String(id).toLowerCase())}`;
  const prev = await cacheGet(key);
  const total = (Number(prev?.total) || 0) + amount;
  await cachePut(
    key,
    { total, updatedAt: Date.now() },
    IDENTITY_TTL_SECS
  );
  return total;
}

function normalizeAmount(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  if (ALLOWED_AMOUNTS.includes(n)) return n;
  // allow exact values only
  return null;
}

function normalizeDeviceId(raw) {
  const s = String(raw || '').trim().slice(0, 64);
  if (!s || !/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
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

/* ── Permanent bot: davidcyriltech ─────────────────────────────── */

function botCreds(env) {
  return {
    username: (env && env.BOT_USERNAME) || BOT.username,
    password: (env && env.BOT_PASSWORD) || BOT.password,
  };
}

function botSessionKey(username) {
  return `https://cd.internal/botsession/v2/${encodeURIComponent(username)}`;
}

async function loginBot(env) {
  const { username, password } = botCreds(env);
  const url = new URL(`${UPSTREAM}/lagoslife/login`);
  url.searchParams.set('username', username);
  url.searchParams.set('password', password);

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 0 },
    });
  } catch {
    throw new Error('LOGIN_UPSTREAM');
  }
  const data = await res.json().catch(() => ({}));
  if (!data.success || !data.result?.session) {
    throw new Error(data.message || data.error || 'LOGIN_FAILED');
  }
  return {
    session: data.result.session,
    username: data.result.username || username,
  };
}

async function saveBotSession(username, session) {
  const exp = Date.now() + SESSION_TTL_SECS * 1000;
  await cachePut(botSessionKey(username), { session, username, exp }, SESSION_TTL_SECS);
  return { session, username, exp, cached: false };
}

async function clearBotSession(env) {
  const { username } = botCreds(env);
  await cachePut(botSessionKey(username), { session: null, exp: 0 }, 1);
}

async function getBotSession(env, { force = false } = {}) {
  const { username } = botCreds(env);

  if (!force) {
    const cached = await cacheGet(botSessionKey(username));
    const margin = SESSION_REFRESH_MARGIN_SECS * 1000;
    if (cached?.session && cached.exp && Date.now() < cached.exp - margin) {
      return {
        session: cached.session,
        username: cached.username || username,
        exp: cached.exp,
        cached: true,
      };
    }
  }

  const fresh = await loginBot(env);
  return saveBotSession(fresh.username, fresh.session);
}

async function botSend(session, to, amount, note) {
  const url = new URL(`${UPSTREAM}/lagoslife/send`);
  url.searchParams.set('session', session);
  url.searchParams.set('to', to);
  url.searchParams.set('amount', String(amount));
  if (note) url.searchParams.set('note', note);
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 0 },
  });
  const data = await res.json().catch(() => ({}));
  return { httpStatus: res.status, data };
}



/** Transfer from permanent bot; refresh session once if auth fails */
async function botGiftTransfer(env, to, amount, note) {
  let bot = await getBotSession(env, { force: false });
  let { data } = await botSend(bot.session, to, amount, note);

  const authFail =
    !data.success &&
    /session|login|auth|unauthorized|expired|cookie/i.test(
      String(data.message || data.error || '')
    );

  if (authFail) {
    await clearBotSession(env);
    bot = await getBotSession(env, { force: true });
    ({ data } = await botSend(bot.session, to, amount, note));
  }

  return { bot, data };
}

/* ── Gift handler ──────────────────────────────────────────────── */

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
  const amount = normalizeAmount(body.amount ?? DEFAULT_AMOUNT);
  const note = 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴠɪᴅ ᴄʏʀɪʟ ᴛᴇᴄʜ';
  const token = body.cf_turnstile_response || body.token || '';
  const deviceId = normalizeDeviceId(body.device_id || body.deviceId);

  if (!to || to.length < 2 || to.length > 32 || !/^[a-zA-Z0-9_]+$/.test(to)) {
    return err(CODES.MISSING_TO, 'Enter a valid Lagos Life username', 400);
  }

  if (!amount) {
    return err(
      CODES.AMOUNT_INVALID,
      'Choose a valid amount: 1M, 2M, 3M, 4M, or 5M.',
      400
    );
  }

  if (to.toLowerCase() === botCreds(env).username.toLowerCase()) {
    return err(CODES.SELF_SEND, 'This username cannot receive gifts here', 400);
  }

  // Lifetime 5M cap per username + IP + device
  const userTotal = await getIdentityTotal('user', to);
  const ipTotal = await getIdentityTotal('ip', ip);
  const deviceTotal = deviceId ? await getIdentityTotal('device', deviceId) : 0;

  const userLeft = Math.max(0, IDENTITY_CAP - userTotal);
  const ipLeft = Math.max(0, IDENTITY_CAP - ipTotal);
  const deviceLeft = deviceId ? Math.max(0, IDENTITY_CAP - deviceTotal) : IDENTITY_CAP;
  const remaining = Math.min(userLeft, ipLeft, deviceLeft);

  if (remaining < MIN_AMOUNT) {
    return err(
      CODES.CAP_REACHED,
      'This account or device has already reached the maximum gift limit (₦5,000,000 total). No further claims are allowed.',
      403,
      {
        cap: {
          limit: IDENTITY_CAP,
          userTotal,
          ipTotal,
          deviceTotal: deviceId ? deviceTotal : null,
          remaining: 0,
        },
      }
    );
  }

  if (amount > remaining) {
    return err(
      CODES.CAP_REACHED,
      `You can receive at most ₦${remaining.toLocaleString()} more on this account/device (₦5,000,000 lifetime max). Choose a smaller amount.`,
      403,
      {
        cap: {
          limit: IDENTITY_CAP,
          userTotal,
          remaining,
        },
      }
    );
  }

  // Global 1-minute race window
  const race = await getRaceState();
  if (!race.open) {
    return err(
      CODES.RACE_WAIT,
      `Someone just claimed. Next open window in ${formatRemaining(race.remaining)} — be ready.`,
      429,
      {
        race: { open: false, remaining: race.remaining, until: race.until },
        cooldown: { remaining: race.remaining, until: race.until, scope: 'race' },
      }
    );
  }

  const daily = await getDailyUsage();
  if (daily.used + amount > GLOBAL_DAILY_CAP) {
    const left = secondsUntilUtcMidnight();
    return err(
      CODES.DAILY_CAP,
      "Today's gift allocation is fully reserved. Distribution resumes after midnight UTC.",
      503,
      { cooldown: { remaining: left, until: Date.now() + left * 1000, scope: 'daily' } }
    );
  }

  const okTs = await verifyTurnstile(token, secret, ip);
  if (!okTs) {
    return err(
      CODES.CAPTCHA,
      'Security check failed. Please complete the verification and try again.',
      403
    );
  }

  try {
    // Double-check race right before send (reduce double-claim races)
    const race2 = await getRaceState();
    if (!race2.open) {
      return err(
        CODES.RACE_WAIT,
        `Someone was faster. Next window in ${formatRemaining(race2.remaining)}.`,
        429,
        {
          race: { open: false, remaining: race2.remaining, until: race2.until },
          cooldown: { remaining: race2.remaining, until: race2.until, scope: 'race' },
        }
      );
    }

    const { data } = await botGiftTransfer(env, to, amount, note);

    if (!data.success) {
      const msg = data.message || data.error || 'Transfer could not be completed';
      if (/too many tries|wait a minute|timeout|busy|rate|limit|try again/i.test(msg)) {
        const locked = await lockRace(null);
        return err(
          CODES.BUSY,
          'Gift lane is cooling down. Next window opens in about a minute — stay ready.',
          503,
          {
            retryAfter: locked.remaining,
            race: { open: false, remaining: locked.remaining, until: locked.until },
            cooldown: { remaining: locked.remaining, until: locked.until, scope: 'race' },
          }
        );
      }
      return err(CODES.SEND_FAILED, msg, 400);
    }

    const locked = await lockRace(to);
    await addDailyUsage(amount);
    const newUserTotal = await addIdentityTotal('user', to, amount);
    await addIdentityTotal('ip', ip, amount);
    if (deviceId) await addIdentityTotal('device', deviceId, amount);

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
      cap: {
        limit: IDENTITY_CAP,
        userTotal: newUserTotal,
        remaining: Math.max(0, IDENTITY_CAP - newUserTotal),
      },
      race: { open: false, remaining: locked.remaining, until: locked.until },
      cooldown: {
        remaining: locked.remaining,
        until: locked.until,
        scope: 'race',
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
    return err(
      CODES.BUSY,
      'Gift service is under high load right now. Please try again in a few minutes.',
      503
    );
  }
}

async function handleRaceStatus(request) {
  // Lightweight public timer — same-origin preferred, but allow GET for the race UI
  const race = await getRaceState();
  const daily = await getDailyUsage();
  const soldOut = daily.used + DEFAULT_AMOUNT > GLOBAL_DAILY_CAP;
  return apiJson({
    success: true,
    code: 'OK',
    race: {
      open: race.open && !soldOut,
      remaining: race.remaining,
      until: race.until,
      gapSeconds: GLOBAL_CLAIM_GAP_SECS,
    },
    daily: {
      soldOut,
      resetsIn: soldOut ? secondsUntilUtcMidnight() : null,
    },
  });
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  if (path === '/race' || path === '/next') {
    if (request.method !== 'GET') {
      return err(CODES.FORBIDDEN, 'Method not allowed', 405);
    }
    return handleRaceStatus(request);
  }

  if (path === '/gift' || path === '/lagoslife/gift') {
    return handleGift(request, env);
  }

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

    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { 'Content-Type': 'text/plain', ...SECURITY_HEADERS },
      });
    }

    if (url.pathname.startsWith('/api')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      }
      try {
        const res = await handleApi(request, env);
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
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
