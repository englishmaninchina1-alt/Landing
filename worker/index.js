// Cloudflare Worker in front of the static site plus a small analytics backend.
//
//   POST /api/collect            record one page view (public, beacon target)
//   GET  /api/stats?days=N       aggregated stats as JSON (admin only)
//   GET  /admin                  dashboard UI (admin only)
//   everything else              served from the ASSETS binding
//
// Admin access uses HTTP Basic auth against the ADMIN_PASSWORD secret; until
// that secret is set the admin routes return a setup page and record nothing.
// Data lives in the D1 binding named DB (the schema is created on first use).

// D1's exec() splits multi-line SQL by newline, so the schema is applied as a
// batch of single statements instead.
const SCHEMA_TABLE = `CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  hour INTEGER NOT NULL,
  path TEXT NOT NULL,
  referrer TEXT,
  ref_host TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  colo TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  lang TEXT,
  visitor TEXT NOT NULL,
  session TEXT NOT NULL,
  ua TEXT
)`;

const SCHEMA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS hits_ts ON hits (ts)',
  'CREATE INDEX IF NOT EXISTS hits_day ON hits (day)',
  'CREATE INDEX IF NOT EXISTS hits_visitor ON hits (visitor)',
  'CREATE INDEX IF NOT EXISTS hits_ref ON hits (ref_host)',
];

const BOT_RE =
  /bot|crawl|spider|slurp|headless|preview|monitor|uptime|curl|wget|python-requests|httpclient|facebookexternalhit|bingpreview|embedly|quora link|whatsapp|telegram/i;

let schemaPromise = null;

function ensureSchema(env) {
  if (!env.DB) return Promise.resolve(false);
  if (!schemaPromise) {
    schemaPromise = env.DB.batch(
      [SCHEMA_TABLE, ...SCHEMA_INDEXES].map((sql) => env.DB.prepare(sql)),
    )
      .then(() => true)
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

function noContent(status = 204) {
  return new Response(null, { status });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      ...extraHeaders,
    },
  });
}

function safeText(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length ? trimmed : null;
}

function parseUA(ua) {
  const u = (ua || '').toLowerCase();

  let os = 'Other';
  if (/windows nt/.test(u)) os = 'Windows';
  else if (/android/.test(u)) os = 'Android';
  else if (/iphone|ipad|ipod/.test(u)) os = 'iOS';
  else if (/cros/.test(u)) os = 'ChromeOS';
  else if (/mac os x|macintosh/.test(u)) os = 'macOS';
  else if (/linux/.test(u)) os = 'Linux';

  let browser = 'Other';
  if (/edg\//.test(u)) browser = 'Edge';
  else if (/opr\/|opera/.test(u)) browser = 'Opera';
  else if (/samsungbrowser/.test(u)) browser = 'Samsung Internet';
  else if (/firefox|fxios/.test(u)) browser = 'Firefox';
  else if (/chrome|crios/.test(u)) browser = 'Chrome';
  else if (/safari/.test(u)) browser = 'Safari';

  let device = 'Desktop';
  if (/ipad|tablet|playbook|silk/.test(u) || (/android/.test(u) && !/mobile/.test(u))) {
    device = 'Tablet';
  } else if (/mobi|iphone|ipod|android|windows phone/.test(u)) {
    device = 'Mobile';
  }

  return { os, browser, device };
}

function refHostOf(referrer, selfHost) {
  if (!referrer) return 'Direct';
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (!host) return 'Direct';
    if (selfHost && (host === selfHost || host.endsWith('.' + selfHost))) return 'Internal';
    return host;
  } catch {
    return 'Unknown';
  }
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function setupPage(message) {
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Admin setup · English Hub</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ee;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#20201d}
  .card{max-width:38rem;margin:2rem;background:#fff;border:1px solid #e3ded3;border-radius:18px;
    padding:2rem;box-shadow:0 18px 40px -30px rgba(0,0,0,.4)}
  h1{margin:0 0 .75rem;font-size:1.5rem}
  p,li{line-height:1.6;color:#4a4740}
  code{background:#f1ede4;border-radius:6px;padding:.15rem .35rem;font-size:.9em}
  ol{padding-left:1.2rem}
  .note{margin-top:1rem;padding:.85rem 1rem;border-radius:12px;background:#fff6e5;border:1px solid #f0dfbb;color:#6d5518}
</style></head><body><div class="card">
<h1>Admin dashboard is locked</h1>
<p>${message}</p>
<ol>
  <li>Open this site in the Sites panel and choose <strong>Secrets</strong>.</li>
  <li>Add a secret named <code>ADMIN_PASSWORD</code> with the password you want.</li>
  <li>Reload this page and sign in when the browser asks.</li>
</ol>
<p class="note">Visit tracking is only stored once the database binding and this password
are in place, so nothing has been collected yet.</p>
</div></body></html>`,
    503,
  );
}

async function isAuthorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const header = request.headers.get('authorization') || '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return false;
  let decoded;
  try {
    decoded = atob(match[1].trim());
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const [a, b] = await Promise.all([sha256(password), sha256(env.ADMIN_PASSWORD)]);
  return constantTimeEqual(a, b);
}

async function requireAdmin(request, env, handler) {
  const authorized = await isAuthorized(request, env);
  if (authorized) return handler();
  if (!env.ADMIN_PASSWORD) {
    return setupPage('No <code>ADMIN_PASSWORD</code> secret is configured for this environment.');
  }
  // Sign-in screen. It also offers the public QR dialog, so anyone who lands
  // here can put the app on a phone without knowing the admin password.
  return html(
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sign in · English Hub</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ee;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#20201d}
  .card{max-width:32rem;margin:2rem;background:#fff;border:1px solid #e3ded3;border-radius:18px;
    padding:2rem;box-shadow:0 18px 40px -30px rgba(0,0,0,.4)}
  h1{margin:0 0 .75rem;font-size:1.4rem}
  p{margin:0 0 1.1rem;line-height:1.6;color:#4a4740}
  .app-link{display:inline-block;padding:.62rem 1.1rem;border-radius:999px;border:1px solid #d8d2c4;
    background:#fbf7ef;color:#14161c;font-weight:600;font-size:.9rem;text-decoration:none}
  .app-link:hover{border-color:#14161c}
  .note{font-size:.85rem;color:#6b6659;margin-bottom:0}
</style></head><body><div class="card">
<h1>Sign in to view analytics</h1>
<p>This dashboard is private, so your browser will ask for the administrator password.
Dismiss that prompt and this page stays here.</p>
<p><a class="app-link" href="/?app=1">Get the app</a></p>
<p class="note">Scan a QR code for Android or iPhone to put English Hub on a phone &mdash;
no sign-in needed for that.</p>
</div></body></html>`,
    401,
    { 'www-authenticate': 'Basic realm="English Hub analytics", charset="UTF-8"' },
  );
}

async function handleCollect(request, env) {
  if (request.method !== 'POST') return noContent(405);
  if (!env.DB) return noContent();
  if (Number(request.headers.get('content-length') || 0) > 8192) return noContent();

  const ua = request.headers.get('user-agent') || '';
  if (BOT_RE.test(ua)) return noContent();
  if (!(request.headers.get('content-type') || '').includes('application/json')) return noContent();

  let body;
  try {
    body = await request.json();
  } catch {
    return noContent();
  }
  if (!body || typeof body !== 'object') return noContent();

  const url = new URL(request.url);
  const ts = Date.now();
  const date = new Date(ts);
  const uaInfo = parseUA(ua);
  const cf = request.cf || {};

  const visitor =
    typeof body.visitor === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.visitor)
      ? body.visitor
      : crypto.randomUUID();
  const session =
    typeof body.session === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.session)
      ? body.session
      : visitor;

  const path = safeText(body.path, 200) || '/';
  const referrer = safeText(body.referrer, 500);

  await ensureSchema(env);

  // Collapse duplicate beacons (double-fire, fast reloads) within 3 seconds.
  const recent = await env.DB.prepare(
    'SELECT ts FROM hits WHERE visitor = ? AND path = ? ORDER BY ts DESC LIMIT 1',
  )
    .bind(visitor, path)
    .all();
  const last = recent.results && recent.results[0];
  if (last && ts - Number(last.ts) < 3000) return noContent();

  await env.DB.prepare(
    `INSERT INTO hits (ts, day, hour, path, referrer, ref_host, utm_source, utm_medium,
       utm_campaign, country, region, city, colo, device, browser, os, lang, visitor, session, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ts,
      date.toISOString().slice(0, 10),
      date.getUTCHours(),
      path,
      referrer,
      refHostOf(referrer, url.hostname),
      safeText(body.utm_source, 100),
      safeText(body.utm_medium, 100),
      safeText(body.utm_campaign, 100),
      cf.country || 'XX',
      cf.region || null,
      cf.city || null,
      cf.colo || null,
      uaInfo.device,
      uaInfo.browser,
      uaInfo.os,
      safeText(body.lang, 20),
      visitor,
      session,
      ua.slice(0, 300),
    )
    .run();

  return noContent();
}

function dayOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function rows(env, sql, ...args) {
  const stmt = env.DB.prepare(sql);
  const ready = args.length ? stmt.bind(...args) : stmt;
  const result = await ready.all();
  return result.results || [];
}

async function handleStats(request, env) {
  if (!env.DB) {
    return json({ error: 'storage_not_configured', message: 'No DB binding on this environment.' }, 503);
  }
  await ensureSchema(env);

  const url = new URL(request.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const startDay = dayOffset(days - 1);
  const today = new Date().toISOString().slice(0, 10);
  const prevStart = dayOffset(days * 2 - 1);
  const prevEnd = dayOffset(days);

  const [
    totals,
    prevTotals,
    todayTotals,
    daily,
    pages,
    referrers,
    campaigns,
    sources,
    qrPlatforms,
    countries,
    cities,
    devices,
    browsers,
    systems,
    languages,
    hours,
    recent,
    newVisitors,
  ] = await Promise.all([
    rows(
      env,
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors,
              COUNT(DISTINCT session) AS sessions
         FROM hits WHERE day >= ?`,
      startDay,
    ),
    rows(
      env,
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? AND day <= ?`,
      prevStart,
      prevEnd,
    ),
    rows(
      env,
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM hits WHERE day = ?`,
      today,
    ),
    rows(
      env,
      `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? GROUP BY day ORDER BY day`,
      startDay,
    ),
    rows(
      env,
      `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 12`,
      startDay,
    ),
    rows(
      env,
      `SELECT ref_host AS host, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? GROUP BY ref_host ORDER BY views DESC LIMIT 20`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(utm_source, '(none)') AS source,
              COALESCE(utm_medium, '(none)') AS medium,
              COALESCE(utm_campaign, '(none)') AS campaign,
              COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? GROUP BY 1, 2, 3 ORDER BY views DESC LIMIT 12`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(utm_source, '(none)') AS source, COUNT(*) AS views,
              COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? GROUP BY source ORDER BY views DESC LIMIT 12`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(utm_medium, '(unknown)') AS medium, COUNT(*) AS scans,
              COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? AND lower(COALESCE(utm_source, '')) = 'qr'
        GROUP BY medium ORDER BY scans DESC`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(country, 'XX') AS country, COUNT(*) AS views,
              COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? GROUP BY country ORDER BY views DESC LIMIT 20`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(city, '(unknown)') AS city, COALESCE(region, '') AS region,
              COALESCE(country, 'XX') AS country, COUNT(*) AS views
         FROM hits WHERE day >= ? GROUP BY 1, 2, 3 ORDER BY views DESC LIMIT 12`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(device, 'Unknown') AS label, COUNT(*) AS views,
              COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ? GROUP BY label ORDER BY views DESC`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(browser, 'Unknown') AS label, COUNT(*) AS views
         FROM hits WHERE day >= ? GROUP BY label ORDER BY views DESC LIMIT 10`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(os, 'Unknown') AS label, COUNT(*) AS views
         FROM hits WHERE day >= ? GROUP BY label ORDER BY views DESC LIMIT 10`,
      startDay,
    ),
    rows(
      env,
      `SELECT COALESCE(lang, '(unknown)') AS label, COUNT(*) AS views
         FROM hits WHERE day >= ? GROUP BY label ORDER BY views DESC LIMIT 10`,
      startDay,
    ),
    rows(
      env,
      `SELECT hour, COUNT(*) AS views FROM hits WHERE day >= ? GROUP BY hour ORDER BY hour`,
      startDay,
    ),
    rows(
      env,
      `SELECT ts, path, ref_host AS host, country, city, device, browser, os
         FROM hits WHERE day >= ? ORDER BY ts DESC LIMIT 50`,
      startDay,
    ),
    rows(
      env,
      `SELECT COUNT(*) AS n FROM (
         SELECT visitor, MIN(day) AS first_seen FROM hits GROUP BY visitor HAVING first_seen >= ?
       )`,
      startDay,
    ),
  ]);

  const bounceRows = await rows(
    env,
    `SELECT COUNT(*) AS n FROM (
       SELECT session FROM hits WHERE day >= ? GROUP BY session HAVING COUNT(*) = 1
     )`,
    startDay,
  );

  const t = totals[0] || { views: 0, visitors: 0, sessions: 0 };
  const prev = prevTotals[0] || { views: 0, visitors: 0 };
  const now = todayTotals[0] || { views: 0, visitors: 0 };
  const newCount = Number((newVisitors[0] || {}).n || 0);
  const sessions = Number(t.sessions || 0);
  const bounces = Number((bounceRows[0] || {}).n || 0);
  const peak = daily.reduce(
    (best, row) => (Number(row.views) > Number(best.views || 0) ? row : best),
    { day: null, views: 0, visitors: 0 },
  );

  return json({
    range: { days, startDay, endDay: today, generatedAt: new Date().toISOString() },
    summary: {
      views: Number(t.views || 0),
      visitors: Number(t.visitors || 0),
      sessions,
      viewsPerVisitor: t.visitors ? Number((Number(t.views) / Number(t.visitors)).toFixed(2)) : 0,
      bounceRate: sessions ? Number(((bounces / sessions) * 100).toFixed(1)) : 0,
      newVisitors: newCount,
      returningVisitors: Math.max(0, Number(t.visitors || 0) - newCount),
      newShare: t.visitors ? Number(((newCount / Number(t.visitors)) * 100).toFixed(1)) : 0,
      today: { views: Number(now.views || 0), visitors: Number(now.visitors || 0) },
      previous: { views: Number(prev.views || 0), visitors: Number(prev.visitors || 0) },
      peakDay: { day: peak.day || null, views: Number(peak.views || 0) },
      countries: countries.length,
    },
    daily: daily.map((r) => ({
      day: r.day,
      views: Number(r.views),
      visitors: Number(r.visitors),
    })),
    pages,
    referrers,
    campaigns,
    countries,
    sources,
    qr: {
      total: qrPlatforms.reduce((n, r) => n + Number(r.scans || 0), 0),
      platforms: qrPlatforms.map((r) => ({
        medium: r.medium,
        scans: Number(r.scans || 0),
        visitors: Number(r.visitors || 0),
      })),
    },
    cities,
    devices,
    browsers,
    systems,
    languages,
    hours: hours.map((r) => ({ hour: Number(r.hour), views: Number(r.views) })),
    recent,
  });
}

async function handleAdminPage(request, env) {
  // Assets redirect /admin/index.html to /admin/, so ask for the directory first.
  for (const pathname of ['/admin/', '/admin/index.html']) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = pathname;
    assetUrl.search = '';
    const response = await env.ASSETS.fetch(
      new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }),
    );
    if (!response.ok) continue;
    const body = await response.text();
    if (body.trim()) return html(body);
  }
  return html('<!doctype html><p>Admin page is missing from this deployment.</p>', 500);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/collect') return await handleCollect(request, env);
      if (pathname === '/api/stats') return await requireAdmin(request, env, () => handleStats(request, env));
      if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
        return await requireAdmin(request, env, () => handleAdminPage(request, env));
      }
    } catch (err) {
      if (pathname === '/api/stats') {
        return json({ error: 'server_error', message: String((err && err.message) || err) }, 500);
      }
      if (pathname === '/api/collect') return noContent();
      return html('<h1>Something went wrong</h1>', 500);
    }

    return env.ASSETS.fetch(request);
  },
};
