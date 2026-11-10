# Landing — English Hub site chooser

Static landing page where students choose between the six English learning
sites (including the 3D "Speak Britain" role-play game), plus a small
first-party analytics backend and admin dashboard.

- `public/` — `index.html`, `styles.css`, `app.js`, `admin/index.html`, `robots.txt`, `images/`. No build step.
- `worker/index.js` — Worker that serves `env.ASSETS` and the analytics API.
- `wrangler.jsonc` — local Workers config (same compatibility date as the manifest).
- `deploy.json` — Freebuff Sites deploy manifest.

## Analytics

No third-party scripts. `public/index.html` sends one JSON beacon per page load
to `POST /api/collect`, which stores a row in the D1 binding `DB`: timestamp,
path, referrer host, `utm_*` campaign fields, Cloudflare country/region/city/colo,
device/browser/OS parsed from the user agent, language, and anonymous visitor and
session ids kept in `localStorage`/`sessionStorage`. Bots and duplicate beacons
(same visitor and path within 3s) are dropped.

| Route | Access | Purpose |
| --- | --- | --- |
| `POST /api/collect` | public | record one page view |
| `GET /api/stats?days=7\|30\|90\|365` | admin | aggregated JSON |
| `GET /admin` | admin | dashboard: KPIs, daily trend, referrers, campaigns, countries, cities, pages, devices, browsers, OS, languages, hour heat map, live feed |

Admin access is HTTP Basic auth against the `ADMIN_PASSWORD` secret. Until it is
set, `/admin` and `/api/stats` return a setup page explaining how to add it, and
nothing is exposed.

### Data model

The schema is created on first use (`worker/index.js`):

```sql
CREATE TABLE hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, day TEXT, hour INTEGER, path TEXT,
  referrer TEXT, ref_host TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  country TEXT, region TEXT, city TEXT, colo TEXT,
  device TEXT, browser TEXT, os TEXT, lang TEXT,
  visitor TEXT, session TEXT, ua TEXT
);
```

`ref_host` is normalised to `Direct`, `Internal` (same-site referrer) or the
referrer hostname without `www.`.

## Run it

```sh
bun install
bun run dev      # http://localhost:3000 (workerd via wrangler dev)
bun run check    # wrangler deploy --dry-run, verifies the bundle and bindings
```

Local D1 state lives in `.wrangler/state`. To exercise the admin routes locally,
pass a throwaway password: `npx wrangler dev --var ADMIN_PASSWORD:local-dev-pass`.

## Deploy it

Freebuff Sites project **Landing** — site id `7c3aa3cc-55fa-4738-ab76-12ebc6e35cb9`.

- production: https://site-1e561cdd25ef49b0ab6d1420ebb0cd7c.freebuff.page (published)
- preview: not deployed yet

Production has a D1 database bound as `DB`. Deploy with `sites_deploy`
(`environment: production`, `manifestPath: deploy.json`), then `sites_set_published`
to publish. Add the `ADMIN_PASSWORD` secret in Sites → Secrets to unlock `/admin`.
