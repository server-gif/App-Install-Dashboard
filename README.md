# App Install Dashboard (Cloudflare Workers + D1)

Live: **https://app-install-dashboard.prime-3.workers.dev**

Account: **Prime - 3** (Cloudflare account id `af34905ea22dd12f78b055fee6e3a890`). Aa project Prime-2 mathi Prime-3 ma move thayelu che.

## Deploy (Cloudflare ma live karva)

Aa badhu kari dewamaa che - nava account mate pan same steps vapari sakay:

```bash
npm install            # wrangler install
npx wrangler login

# 1) Database banavo
npx wrangler d1 create installs-db
#    -> output ma aavelu database_id wrangler.toml ma paste karo (karayelu che)

# 2) Tables banavo (remote = live database). schema.sql ma badha columns che, etle nava DB mate fakat aa j vaparo:
npx wrangler d1 execute installs-db --remote --file=schema.sql
#    (migrations/001_country_flow.sql fakat PURANA DB upgrade karva mate che - nava DB par chalavjo nahi)

# 3) Session secret set karo (random lambo string)
openssl rand -hex 32          # copy karo
npx wrangler secret put SESSION_SECRET

# 4) Deploy
npx wrangler deploy
```

Status: Prime - 3 account ma D1 `installs-db` (id `a479437e-dafc-47f3-a33a-ee28e60e1891`, region APAC) banayelu che, `schema.sql` remote par
apply thayelo che (4 tables + install_tag/created_at/country columns confirm), SESSION_SECRET set che, ane Worker deploy chea
Prime-3 par (version `bec5540c-1a67-40e2-9f75-d3a4e96a5afd`) - **prime-3 live ane local bene par 122 automated checks pass thaya chea**.
wrangler.toml ma `account_id` + nava `database_id` set che.

Deploy pachi URL (`https://app-install-dashboard.<tamaro-subdomain>.workers.dev`) kholo.
Pehli var khulse tyare **main admin** create karvanu screen aavse. Turant banavi lejo.

Custom domain: Cloudflare Dashboard -> Workers & Pages -> app-install-dashboard -> Settings -> Domains & Routes.

## Local test

```bash
echo 'SESSION_SECRET=local-dev-secret-change-me' > .dev.vars
npx wrangler d1 execute installs-db --local --file=schema.sql
npx wrangler dev
```

Demo data (3 apps, 20 installs, 12 countries, 1 sub user) joyto to local par:

```bash
powershell -ExecutionPolicy Bypass -File .\seed-demo.ps1   # login: demo / Demo12345  ke  ravi / Ravi@12345
```

Full API + permission test suite (local ke live par chale):

```bash
powershell -ExecutionPolicy Bypass -File .\smoke-test.ps1
# live (Prime-3) par chalva mate pehla token+account env set karo:
$env:CLOUDFLARE_API_TOKEN="<prime-3 token>"; $env:CLOUDFLARE_ACCOUNT_ID="af34905ea22dd12f78b055fee6e3a890"
powershell -ExecutionPolicy Bypass -File .\smoke-test.ps1 -BaseUrl https://app-install-dashboard.prime-3.workers.dev -D1Target remote
```
Test suro thi aekje data delete kari dechhe, etle live par chale tyare "Create main admin" screen j ravshe.

## App icons (package name thi)
- App banarta velle `package_name` aape to Worker Play Store listing ni `og:image` vapari icon URL kadhse; na malyu to iOS App Store nu iTunes `lookup` (artworkUrl) try kare. Malyu nahi to `icon_url` = null ane dashboard card par app na name no **first letter** avatar dekhse.
- Eela `apps` ma `icon_url TEXT` column che (nava DB mate `schema.sql` ma j che; purana DB mate `migrations/002_app_icon.sql`).
- Refresh: `POST /api/apps/<id>/icon` (admin) - package name badlay ke navo set thay to icon panee fetch thay.

## Install track karvani API (mobile app mathi)

```
POST /api/track/install
Headers: X-API-Key: <app ni api key>, Content-Type: application/json
Body: {
  "device_id":    "<unique per-device id>",         // required (ekj required field)
  "package_name": "com.x.mygame"                    // optional - app check thay chhe
}
// country ane installed_at app side thi moklvana j nathi - server API call mathi j auto-lene chhe (neeche joye)
```
- Same `app_id` + `device_id` mate duplicate rows banati nathi; darek API call e tena `install_count` ma **+1** thay chhe (pehli var = 1). API response ma huvo latest `install_count` aave chhe. Installs table ane detail page ma `device_id` sathe eo count pan dekhay.
- `package_name` app ke record sathe milto hoy to j store thay; jo app par package set na hoy to auto-backfill thay chhe.
- `country` **fakat API call mathi j** leay chhe - Cloudflare geolocation (`request.cf.country`) mathi, API call karta aavela IP par thi. Body ma `country` mokle to te **ignore** thay chhe (kem ke `installed_at` pan server-side j thi aave chhe). Unknown/missing hoy to `XX`. Note: local `wrangler dev` par `request.cf` tamara real machine na IP pramane simulate thay chhe - VPN localhost mate lagu nathi padti; live par j IP pramane country aavshe.
- `installed_at` **auto** set thay chhe - server receive time (API call aavti var e). App side thi moklvu janevu nathi. (Jo body ma timestamp mokle to te override/backfill mate vaparay; invalid / future / 2 varsa thi juna hoy to phir pan server time.)
- Fatke `device_id` required che; badhu biju optional ane auto - etle purani integrations pan same rhave chhe.

## Reporting APIs (dashboard vapare chhe)

| Endpoint | Vistar |
|---|---|
| `GET /api/stats?app_id=&days= \| &from=&to=` | KPIs, daily series, country breakdown, recent installs |
| `GET /api/countries?app_id=&days= \| &from=&to=` | country x app matrix (ketla app kai country ma ketli var) |
| `GET /api/installs?app_id=&country=&from=&to=&q=&page=&per=` | stored raw records + filters + paging |
| `GET /api/installs.csv?...` | tena j filters sathe CSV export |

Badha endpoints server par j permission check kare chhe - sub user ne fakat aapeli apps no j data male chhe.

**Date filter:** Dashboard detail, By Country ane Installs - badha jaga eka j **DateRangePicker** calendar vaparay chhe (presets: Today / Last 7 / 30 / 90 / 365 days, athva custom from-to range). `days=N` akeli j vithe badhva-dine anchor thay chhe; `from`/`to` aapya to eka spast range vaparay (donha eka j API ma support chhe).

## Dashboard (side bar jeema 5 views chhe)
- **Dashboard** - app na **cards** (package name thi Play Store / App Store nu **icon**); koi card par click karo to teni detail niche khule (Total/Today/Period KPIs + Country breakdown + recent installs). Koi graph/chart nathi.
- **By Country** - country x app heat matrix. Koi row par click karvo to tema raw installs khulse.
- **Installs** - badha stored records; country / date-range / search filters ane Export CSV.
- **Apps & API** (admin) - apps banavo (package name aavyu to icon auto-fetch thay), API key copy, ane ready-to-paste cURL / Android / iOS / Web code snippets. **Icon** button thi store icon panee fetch/refresh kari shake.
- **Users** (admin) - sub users banavo ane app-wise permissions aapo.

## Roles
- **Main admin**: badhi apps, app create/delete/key rotate, sub users create/edit/delete.
- **Sub user**: fakat admin e aapeli apps no j data dekhse (server par j check thay chhe).

## Security tips
- Cloudflare -> Security -> WAF -> Rate limiting: `/api/login` par limit lagavo (brute-force thi bachva).
- Dashboard ne vadhu secure karva Cloudflare Access (Zero Trust) pan upar lagavi sakay.
- Timezone badalva `TZ_OFFSET_MIN` (wrangler.toml) badlo (IST = 330).
