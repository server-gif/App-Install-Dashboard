// App Install Dashboard - Cloudflare Worker (D1 + static assets)

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = {
  enc: (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
const err = (msg, status = 400) => json({ error: msg }, status);

const SESSION_DAYS = 7;

/* ---------- crypto helpers ---------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(env, payload) {
  const body = b64u.enc(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), enc.encode(body));
  return body + "." + b64u.enc(sig);
}
async function verifyToken(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), b64u.dec(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(b64u.dec(body)));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}
const newSalt = () => b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
async function hashPassword(password, salt) {
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64u.dec(salt), iterations: 100000 },
    keyMat,
    256
  );
  return b64u.enc(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const randomKey = () =>
  "ik_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

/* ---------- misc helpers ---------- */
function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
async function sessionCookie(env, userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const token = await signToken(env, { uid: userId, exp });
  return `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearCookie = "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const cleanIds = (arr) =>
  Array.isArray(arr) ? [...new Set(arr.map(Number).filter(Number.isInteger))].slice(0, 500) : [];
const validUsername = (u) => /^[a-z0-9_.-]{3,32}$/i.test(u);

/* ---------- app icon resolution (Google Play, then iOS App Store) ----------
   Called when an app is created (or refreshed) with a package/bundle id.
   Returns a public image URL, or null if nothing is found. Never throws. */
async function resolveIcon(pkg) {
  if (!pkg) return null;
  const id = encodeURIComponent(pkg);
  const sig = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  // Google Play: the listing page exposes the icon as <meta property="og:image">.
  // Try the US storefront first, then a region-neutral URL (some apps are not served to gl=US and 404 there).
  const playUrls = [`https://play.google.com/store/apps/details?id=${id}&hl=en&gl=US`, `https://play.google.com/store/apps/details?id=${id}&hl=en`];
  for (const u of playUrls) {
    try {
      const res = await fetch(u, { signal: sig(6000) });
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(/<meta property="og:image" content="([^"]+)"/) || html.match(/"image"\s*:\s*"([^"]+googleusercontent[^"]+)"/);
      if (m && /^https:\/\//.test(m[1])) return m[1];
    } catch {}
  }
  // iOS App Store: iTunes lookup by bundle id -> artworkUrl100 (upscale to 256)
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?bundleId=${id}&country=US`, { signal: sig(6000) });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      const art = j && j.results && j.results[0] && j.results[0].artworkUrl100;
      if (art) return art.replace(/100x100bb/, "256x256bb");
    }
  } catch {}
  return null;
}

/* Validate a manually supplied icon: an http(s) image URL (e.g. a Play Store icon link) or an
   inlined data:image URL (from drag-and-drop). Capped so it stays well under D1's statement size. */
function validIconUrl(u) {
  return typeof u === "string" && ((/^https?:\/\/.+/i.test(u) && !/["'<>]/.test(u)) || /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(u)) && u.length <= 2000000;
}

/* ---------- country + timestamp resolution (install tracking input) ---------- */
const normName = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Build ISO-3166 alpha-2 set + english-name -> code map once per isolate (apps may send "India" or "IN").
const CN = (() => {
  const valid = new Set();
  const byName = new Map();
  let dn;
  try {
    dn = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return { valid, byName };
  }
  for (let i = 65; i <= 90; i++)
    for (let j = 65; j <= 90; j++) {
      const code = String.fromCharCode(i, j);
      let name;
      try {
        name = dn.of(code);
      } catch {
        continue;
      }
      if (!name || name.toUpperCase() === code) continue; // unknown code falls back to the code itself
      valid.add(code);
      const k = normName(name);
      if (k && !byName.has(k)) byName.set(k, code);
    }
  // frequent aliases / short forms a mobile app tends to send
  for (const [name, code] of [
    ["usa", "US"], ["united states of america", "US"], ["america", "US"],
    ["uk", "GB"], ["great britain", "GB"], ["england", "GB"],
    ["uae", "AE"], ["united arab emirates", "AE"],
    ["korea", "KR"], ["south korea", "KR"], ["russia", "RU"],
    ["vietnam", "VN"], ["tanzania", "TZ"], ["saudi arabia", "SA"],
    ["czechia", "CZ"], ["czech republic", "CZ"], ["turkiye", "TR"], ["turkey", "TR"],
    ["ivory coast", "CI"], ["new zealand", "NZ"], ["bharat", "IN"],
  ])
    if (valid.has(code)) byName.set(name, code);
  return { valid, byName };
})();

/* "IN" | "in" | "India" | "  india " -> "IN", anything unknown -> null */
function resolveCountry(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (/^[a-z]{2}$/i.test(s)) {
    const c = s.toUpperCase();
    return CN.valid.has(c) ? c : null;
  }
  return CN.byName.get(normName(s)) || null;
}

const utcStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
// reject nonsense client timestamps (far future / older than 2 years) so stats stay trustworthy
function saneStamp(ms) {
  const now = Date.now();
  if (ms > now + 86400000 || ms < now - 730 * 86400000) return null;
  return utcStamp(ms);
}
/* accepts ISO, "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD", epoch s/ms -> "YYYY-MM-DD HH:MM:SS" (UTC) */
function parseClientDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return saneStamp(v > 1e11 ? v : v * 1000);
  if (typeof v !== "string") return null;
  let s = v.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
  else if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? saneStamp(ms) : null;
}
const dayInput = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null);
/* a dashboard date pick is in the viewer's tz -> convert that midnight to a UTC stamp for filtering */
function localDayToUtc(day, tz, endOfDay = false) {
  const t = Date.parse(day + "T00:00:00Z") - tz * 60000;
  if (Number.isNaN(t)) return null;
  return utcStamp(t + (endOfDay ? 86399000 : 0));
}

/* date-window helpers - calendar day strings 'YYYY-MM-DD', interpreted in the viewer/server tz */
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const daySpan = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000) + 1;
const todayStr = (tz) => new Date(Date.now() + tz * 60000).toISOString().slice(0, 10);
/* ?from=&to= (an absolute range from the calendar) override ?days=; days stays anchored to "today" */
function resolveRange(url, tz, defaultDays) {
  const f = dayInput(url.searchParams.get("from")), t = dayInput(url.searchParams.get("to"));
  if (f && t) { const [a, b] = f <= t ? [f, t] : [t, f]; return { from: a, to: b, days: Math.min(3650, daySpan(a, b)) }; }
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days")) || defaultDays || 30));
  const to = todayStr(tz);
  return { from: addDays(to, -(days - 1)), to, days };
}

async function getUser(request, env) {
  const p = await verifyToken(env, getCookie(request, "session"));
  if (!p) return null;
  // role + existence always from DB so permission changes are instant
  return await env.DB.prepare("SELECT id, username, role FROM users WHERE id = ?").bind(p.uid).first();
}
async function allowedAppIds(env, user) {
  const q =
    user.role === "admin"
      ? env.DB.prepare("SELECT id FROM apps")
      : env.DB.prepare("SELECT app_id AS id FROM user_apps WHERE user_id = ?").bind(user.id);
  const { results } = await q.all();
  return results.map((r) => r.id);
}
async function setUserApps(env, userId, appIds) {
  const stmts = [env.DB.prepare("DELETE FROM user_apps WHERE user_id = ?").bind(userId)];
  for (const a of appIds)
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO user_apps (user_id, app_id) SELECT ?, id FROM apps WHERE id = ?").bind(userId, a)
    );
  await env.DB.batch(stmts);
}

/* ---------- entry ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.SESSION_SECRET) return err("SESSION_SECRET is not configured", 500);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      console.error(e);
      return err("Server error", 500);
    }
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  // Public API used by your mobile apps (API-key auth)
  if (path === "/api/track/install" && method === "POST") return trackInstall(request, env);

  // CSRF guard for dashboard mutations
  if (method !== "GET" && method !== "HEAD" && request.headers.get("X-Requested-With") !== "dashboard")
    return err("Bad request", 400);

  if (path === "/api/setup-status" && method === "GET") {
    const r = await env.DB.prepare("SELECT COUNT(*) c FROM users").first();
    return json({ needs_setup: r.c === 0 });
  }

  if (path === "/api/setup" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const username = clean(b.username, 32).toLowerCase();
    const password = typeof b.password === "string" ? b.password : "";
    if (!validUsername(username)) return err("Username: 3-32 chars (a-z, 0-9, _ . -)");
    if (password.length < 8) return err("Password must be at least 8 characters");
    const salt = newSalt();
    const hash = await hashPassword(password, salt);
    const r = await env.DB.prepare(
      "INSERT INTO users (username, password_hash, salt, role) SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)"
    )
      .bind(username, hash, salt)
      .run();
    if (!r.meta.changes) return err("Already set up", 409);
    const u = await env.DB.prepare("SELECT id, username, role FROM users WHERE username = ?").bind(username).first();
    return json({ user: u }, 200, { "Set-Cookie": await sessionCookie(env, u.id) });
  }

  if (path === "/api/login" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const username = clean(b.username, 32);
    const password = typeof b.password === "string" ? b.password : "";
    const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    const salt = row ? row.salt : newSalt();
    const hash = await hashPassword(password, salt); // always hash (timing)
    if (!row || !safeEqual(hash, row.password_hash)) return err("Invalid username or password", 401);
    return json({ user: { id: row.id, username: row.username, role: row.role } }, 200, {
      "Set-Cookie": await sessionCookie(env, row.id),
    });
  }

  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearCookie });

  // ---- everything below needs login ----
  const user = await getUser(request, env);
  if (!user) return err("Unauthorized", 401);
  const isAdmin = user.role === "admin";
  const adminOnly = () => (isAdmin ? null : err("Admin only", 403));

  if (path === "/api/me" && method === "GET") return json({ user });

  if (path === "/api/password" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    const cur = await hashPassword(String(b.current || ""), row.salt);
    if (!safeEqual(cur, row.password_hash)) return err("Current password is wrong", 403);
    if (typeof b.new !== "string" || b.new.length < 8) return err("New password must be at least 8 characters");
    const salt = newSalt();
    await env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
      .bind(await hashPassword(b.new, salt), salt, user.id)
      .run();
    return json({ ok: true });
  }

  if (path === "/api/apps" && method === "GET") {
    // optional ?from=&to= (both required) also returns installs counted inside that range, per app
    const { tz, off } = tzInfo(env);
    const rf = dayInput(url.searchParams.get("from")), rt = dayInput(url.searchParams.get("to"));
    const r0 = rf && rt ? (rf <= rt ? [rf, rt] : [rt, rf]) : null;
    const base = `SELECT a.id, a.name, a.package_name, a.icon_url, a.created_at${isAdmin ? ", a.api_key" : ""},
      (SELECT COUNT(*) FROM installs i WHERE i.app_id = a.id) AS total${r0 ? ", (SELECT COUNT(*) FROM installs i WHERE i.app_id = a.id AND date(i.installed_at, ?) BETWEEN ? AND ?) AS period" : ""} FROM apps a`;
    const q = isAdmin
      ? env.DB.prepare(base + " ORDER BY a.name COLLATE NOCASE")
      : env.DB.prepare(
          base + " JOIN user_apps ua ON ua.app_id = a.id WHERE ua.user_id = ? ORDER BY a.name COLLATE NOCASE"
        );
    // placeholders appear before the user filter, so the range binds first, then the user id (bind returns a NEW statement)
    let stmt = q;
    if (r0) stmt = stmt.bind(off, r0[0], r0[1]);
    if (!isAdmin) stmt = stmt.bind(user.id);
    const { results } = await stmt.all();
    return json({ apps: results, range: r0 ? { from: r0[0], to: r0[1] } : null });
  }

  if (path === "/api/stats" && method === "GET") return stats(env, user, url);

  // app-wise / country-wise reports + the stored raw install records (all permission filtered)
  if (path === "/api/countries" && method === "GET") return countriesReport(env, user, url);
  if (path === "/api/installs" && method === "GET") return installsQuery(env, user, url, false);
  if (path === "/api/installs.csv" && method === "GET") return installsQuery(env, user, url, true);

  // ---- admin: apps ----
  if (path === "/api/apps" && method === "POST") {
    const d = adminOnly();
    if (d) return d;
    const b = await request.json().catch(() => ({}));
    const name = clean(b.name, 60);
    if (!name) return err("App name required");
    const pkg = clean(b.package_name, 100) || null;
    // fetch the store icon by package name (Play Store, else iOS App Store); null if not found.
    // A manually supplied icon (pasted URL or dropped data-URL) wins over auto-resolution.
    let icon = await resolveIcon(pkg);
    if (validIconUrl(b.icon_url)) icon = b.icon_url.trim();
    const key = randomKey();
    const r = await env.DB.prepare("INSERT INTO apps (name, package_name, api_key, icon_url) VALUES (?, ?, ?, ?)")
      .bind(name, pkg, key, icon)
      .run();
    return json({ id: r.meta.last_row_id, name, package_name: pkg, api_key: key, icon_url: icon }, 201);
  }

  let m = path.match(/^\/api\/apps\/(\d+)(\/rotate-key|\/icon)?$/);
  if (m) {
    const d = adminOnly();
    if (d) return d;
    const id = Number(m[1]);
    if (m[2] === "/rotate-key" && method === "POST") {
      const key = randomKey();
      const r = await env.DB.prepare("UPDATE apps SET api_key = ? WHERE id = ?").bind(key, id).run();
      if (!r.meta.changes) return err("Not found", 404);
      return json({ api_key: key });
    }
    // re-fetch the store icon for an existing app (e.g. package name was added/changed after creation)
    if (m[2] === "/icon" && method === "POST") {
      const app = await env.DB.prepare("SELECT package_name FROM apps WHERE id = ?").bind(id).first();
      if (!app) return err("Not found", 404);
      if (!app.package_name) return err("No package name set - add a package name first", 400);
      const icon = await resolveIcon(app.package_name);
      await env.DB.prepare("UPDATE apps SET icon_url = ? WHERE id = ?").bind(icon, id).run();
      return json({ icon_url: icon, found: !!icon });
    }
    // edit an existing app: name and/or package_name. When package_name changes, re-resolve the store icon.
    if (!m[2] && method === "PUT") {
      const b = await request.json().catch(() => ({}));
      const cur = await env.DB.prepare("SELECT name, package_name, icon_url FROM apps WHERE id = ?").bind(id).first();
      if (!cur) return err("Not found", 404);
      const name = b.name !== undefined ? clean(b.name, 60) : cur.name;
      if (!name) return err("App name required");
      const pkg = b.package_name !== undefined ? (clean(b.package_name, 100) || null) : cur.package_name;
      let icon = cur.icon_url;
      let found = true;
      if (b.icon_url !== undefined) {
        // manual icon path: an explicit URL / data-URL, or an empty string to clear it
        const manual = typeof b.icon_url === "string" ? b.icon_url.trim() : "";
        if (manual === "") { icon = null; found = false; }
        else if (validIconUrl(manual)) { icon = manual; found = true; }
        else return err("Icon URL kharabu chhe - https:// image link ke ek image file drag karo", 400);
      } else if (pkg !== cur.package_name) {
        icon = await resolveIcon(pkg);
        found = !!icon;
      }
      await env.DB.prepare("UPDATE apps SET name = ?, package_name = ?, icon_url = ? WHERE id = ?").bind(name, pkg, icon, id).run();
      return json({ id, name, package_name: pkg, icon_url: icon, found });
    }
    if (!m[2] && method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM installs WHERE app_id = ?").bind(id),
        env.DB.prepare("DELETE FROM user_apps WHERE app_id = ?").bind(id),
        env.DB.prepare("DELETE FROM apps WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  // ---- admin: users ----
  if (path === "/api/users" && method === "GET") {
    const d = adminOnly();
    if (d) return d;
    const [us, ua] = await env.DB.batch([
      env.DB.prepare("SELECT id, username, role, created_at FROM users ORDER BY role, username"),
      env.DB.prepare("SELECT user_id, app_id FROM user_apps"),
    ]);
    const map = {};
    for (const r of ua.results) (map[r.user_id] ||= []).push(r.app_id);
    return json({ users: us.results.map((u) => ({ ...u, app_ids: map[u.id] || [] })) });
  }

  if (path === "/api/users" && method === "POST") {
    const d = adminOnly();
    if (d) return d;
    const b = await request.json().catch(() => ({}));
    const username = clean(b.username, 32).toLowerCase();
    const password = typeof b.password === "string" ? b.password : "";
    if (!validUsername(username)) return err("Username: 3-32 chars (a-z, 0-9, _ . -)");
    if (password.length < 8) return err("Password must be at least 8 characters");
    const salt = newSalt();
    let uid;
    try {
      const r = await env.DB.prepare(
        "INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, 'user')"
      )
        .bind(username, await hashPassword(password, salt), salt)
        .run();
      uid = r.meta.last_row_id;
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return err("Username already exists", 409);
      throw e;
    }
    await setUserApps(env, uid, cleanIds(b.app_ids));
    return json({ id: uid }, 201);
  }

  m = path.match(/^\/api\/users\/(\d+)$/);
  if (m) {
    const d = adminOnly();
    if (d) return d;
    const id = Number(m[1]);
    const target = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(id).first();
    if (!target) return err("Not found", 404);
    if (target.role === "admin") return err("Main admin cannot be modified here", 403);
    if (method === "PUT") {
      const b = await request.json().catch(() => ({}));
      if (b.password !== undefined && b.password !== "") {
        if (typeof b.password !== "string" || b.password.length < 8) return err("Password must be at least 8 characters");
        const salt = newSalt();
        await env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
          .bind(await hashPassword(b.password, salt), salt, id)
          .run();
      }
      if (b.app_ids !== undefined) await setUserApps(env, id, cleanIds(b.app_ids));
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM user_apps WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  return err("Not found", 404);
}

/* ---------- install tracking (called from the mobile apps) ---------- */
async function trackInstall(request, env) {
  const key = request.headers.get("X-API-Key");
  if (!key) return err("Missing X-API-Key", 401);
  const app = await env.DB.prepare("SELECT id, name, package_name FROM apps WHERE api_key = ?").bind(key).first();
  if (!app) return err("Invalid API key", 401);

  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return err("Body must be JSON");

  const deviceId = clean(b.device_id, 128);
  if (!deviceId) return err("device_id required");

  // package_name is optional but must belong to this key when the app already has one registered
  const pkg = clean(b.package_name, 100).toLowerCase() || clean(b.app_package, 100).toLowerCase();
  if (pkg && app.package_name && app.package_name.toLowerCase() !== pkg)
    return err("package_name does not match this API key's app", 400);

  // country is derived ONLY from the caller's IP via Cloudflare geolocation on the API call itself
  // (same idea as installed_at coming from server receive time) - a body-supplied country is ignored
  const country = resolveCountry(request.cf?.country) || "XX";

  // installed_at defaults to the server receive time taken from the API call itself (no need to send it);
  // an app-supplied timestamp is an optional override (e.g. for backfilling past installs)
  const installedAt = parseClientDate(b.installed_at ?? b.install_date ?? b.installedAt ?? b.timestamp);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO installs (app_id, device_id, country, installed_at)
       VALUES (?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(app_id, device_id) DO UPDATE SET install_count = install_count + 1`
    ).bind(app.id, deviceId, country, installedAt),
  ];
  // remember the package the app reported, if the admin left it blank
  if (pkg && !app.package_name)
    stmts.push(env.DB.prepare("UPDATE apps SET package_name = ? WHERE id = ? AND package_name IS NULL").bind(pkg, app.id));

  await env.DB.batch(stmts);
  const cur = await env.DB.prepare("SELECT install_count AS c FROM installs WHERE app_id = ? AND device_id = ?").bind(app.id, deviceId).first();
  return json({ ok: true, app_id: app.id, country, install_count: cur?.c || 1 });
}

/* ---------- dashboard stats ---------- */
function tzInfo(env) {
  const tz = parseInt(env.TZ_OFFSET_MIN ?? "0", 10) || 0;
  return { tz, off: `${tz >= 0 ? "+" : "-"}${Math.abs(tz)} minutes` };
}

/* resolves ?app_id= against what this user may see: admin = all, sub user = granted apps only */
async function pickApps(env, user, url) {
  const allowed = await allowedAppIds(env, user);
  const want = url.searchParams.get("app_id") || "all";
  if (want === "all") return { ids: allowed };
  const id = parseInt(want);
  if (!allowed.includes(id)) return { error: err("Forbidden", 403) };
  return { ids: [id] };
}

async function stats(env, user, url) {
  const { tz, off } = tzInfo(env);
  const { from: Rf, to: Rt, days } = resolveRange(url, tz, 30);

  const sel = await pickApps(env, user, url);
  if (sel.error) return sel.error;
  const ids = sel.ids;

  // date series across the resolved window (filled with zeros)
  const series = [];
  for (let i = 0; i < days; i++) series.push({ d: addDays(Rf, i), c: 0 });

  if (!ids.length)
    return json({ total: 0, today: 0, period: 0, prev: 0, from: Rf, to: Rt, days, series, country: [], per_app: [], recent: [] });

  const ph = ids.map(() => "?").join(",");
  const today = todayStr(tz);
  const prevFrom = addDays(Rf, -days), prevTo = addDays(Rf, -1);
  const S = (sql, ...p) => env.DB.prepare(sql).bind(...p);
  const inRange = "date(installed_at, ?) BETWEEN ? AND ?";

  const [total, todayC, daily, prev, country, perApp, recent] = await env.DB.batch([
    S(`SELECT COUNT(*) c FROM installs WHERE app_id IN (${ph})`, ...ids),
    S(`SELECT COUNT(*) c FROM installs WHERE app_id IN (${ph}) AND date(installed_at, ?) = ?`, ...ids, off, today),
    S(
      `SELECT date(installed_at, ?) d, COUNT(*) c FROM installs WHERE app_id IN (${ph}) AND ${inRange} GROUP BY d`,
      off, ...ids, off, Rf, Rt
    ),
    S(
      `SELECT COUNT(*) c FROM installs WHERE app_id IN (${ph}) AND date(installed_at, ?) BETWEEN ? AND ?`,
      ...ids, off, prevFrom, prevTo
    ),
    // every country where installs happened (no top-10 cap) - dashboard shows the full list
    S(
      `SELECT country AS k, COUNT(*) AS c FROM installs WHERE app_id IN (${ph}) AND ${inRange} GROUP BY country ORDER BY c DESC`,
      ...ids, off, Rf, Rt
    ),
    S(
      `SELECT a.id, a.name,
        (SELECT COUNT(*) FROM installs i WHERE i.app_id = a.id) AS total,
        (SELECT COUNT(*) FROM installs i WHERE i.app_id = a.id AND date(i.installed_at, ?) BETWEEN ? AND ?) AS period
       FROM apps a WHERE a.id IN (${ph}) ORDER BY total DESC`,
      off, Rf, Rt, ...ids
    ),
    S(
      `SELECT datetime(i.installed_at, ?) AS t, a.name AS app, i.country, i.device_id, i.install_count
       FROM installs i JOIN apps a ON a.id = i.app_id WHERE i.app_id IN (${ph}) AND date(i.installed_at, ?) BETWEEN ? AND ? ORDER BY i.installed_at DESC, i.id DESC`,
      off, ...ids, off, Rf, Rt
    ),
  ]);

  const byDay = Object.fromEntries(daily.results.map((r) => [r.d, r.c]));
  let period = 0;
  for (const s of series) {
    s.c = byDay[s.d] || 0;
    period += s.c;
  }

  return json({
    total: total.results[0].c,
    today: todayC.results[0].c,
    period,
    prev: prev.results[0].c,
    from: Rf,
    to: Rt,
    days,
    series,
    country: country.results,
    per_app: perApp.results,
    recent: recent.results.map((r) => ({ ...r, t: r.t.replace(" ", "T") })), // already shifted to local tz (TZ_OFFSET_MIN) in SQL
  });
}

/* ---------- country x app matrix ---------- */
async function countriesReport(env, user, url) {
  const { tz, off } = tzInfo(env);
  const { from: Rf, to: Rt, days } = resolveRange(url, tz, 30);
  const sel = await pickApps(env, user, url);
  if (sel.error) return sel.error;
  const ids = sel.ids;
  if (!ids.length) return json({ days, from: Rf, to: Rt, apps: [], countries: [] });

  const ph = ids.map(() => "?").join(",");
  const inRange = "date(i.installed_at, ?) BETWEEN ? AND ?";
  const S = (sql, ...p) => env.DB.prepare(sql).bind(...p);

  const [byCountry, matrix, apps] = await env.DB.batch([
    S(
      `SELECT i.country AS country, COUNT(*) AS total FROM installs i WHERE i.app_id IN (${ph}) AND ${inRange}
       GROUP BY i.country ORDER BY total DESC LIMIT 150`,
      ...ids, off, Rf, Rt
    ),
    S(
      `SELECT i.app_id AS app_id, i.country AS country, COUNT(*) AS c FROM installs i
       WHERE i.app_id IN (${ph}) AND ${inRange} GROUP BY i.app_id, i.country`,
      ...ids, off, Rf, Rt
    ),
    S(
      `SELECT a.id, a.name, a.package_name, COUNT(i.id) AS total
       FROM apps a LEFT JOIN installs i ON i.app_id = a.id AND ${inRange}
       WHERE a.id IN (${ph}) GROUP BY a.id ORDER BY total DESC`,
      off, Rf, Rt, ...ids
    ),
  ]);

  const perApp = {};
  for (const r of matrix.results) (perApp[r.country || "XX"] ||= {})[r.app_id] = r.c;

  return json({
    days,
    from: Rf,
    to: Rt,
    apps: apps.results,
    countries: byCountry.results.map((r) => ({
      country: r.country || "XX",
      total: r.total,
      by_app: perApp[r.country] || {},
    })),
  });
}

/* ---------- stored install records (table + CSV export) ---------- */
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function installsQuery(env, user, url, asCsv) {
  const { tz } = tzInfo(env);
  const sel = await pickApps(env, user, url);
  if (sel.error) return sel.error;
  const ids = sel.ids;

  const per = Math.min(200, Math.max(1, parseInt(url.searchParams.get("per")) || 50));
  const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
  if (!ids.length)
    return asCsv ? csvResponse("") : json({ rows: [], total: 0, page, per_page: per, pages: 0, countries: [] });

  const p = [...ids];
  const cond = [`i.app_id IN (${ids.map(() => "?").join(",")})`];

  const country = resolveCountry(url.searchParams.get("country"));
  if (country) { cond.push("i.country = ?"); p.push(country); }

  const from = dayInput(url.searchParams.get("from"));
  if (from) { const v = localDayToUtc(from, tz); if (v) { cond.push("i.installed_at >= ?"); p.push(v); } }
  const to = dayInput(url.searchParams.get("to"));
  if (to) { const v = localDayToUtc(to, tz, true); if (v) { cond.push("i.installed_at <= ?"); p.push(v); } }

  const q = clean(url.searchParams.get("q"), 60);
  if (q) {
    cond.push("(i.device_id LIKE ? OR a.name LIKE ?)");
    const like = "%" + q.replace(/[\\%_]/g, "") + "%";
    p.push(like, like);
  }

  const where = cond.join(" AND ");
  const base = `FROM installs i JOIN apps a ON a.id = i.app_id WHERE ${where}`;
  const S = (sql, ...params) => env.DB.prepare(sql).bind(...params);

  const [cnt, rows, cFacet] = await env.DB.batch([
    S(`SELECT COUNT(*) AS c ${base}`, ...p),
    S(
      `SELECT i.id, i.installed_at, i.created_at, i.device_id,
              i.country, i.install_count, a.name AS app, a.package_name
       ${base} ORDER BY i.id DESC LIMIT ? OFFSET ?`,
      ...p, asCsv ? 50000 : per, asCsv ? 0 : (page - 1) * per
    ),
    // dropdown options scoped to what this user may see (so no hidden value can be guessed)
    S(`SELECT DISTINCT i.country AS k FROM installs i WHERE i.app_id IN (${ids.map(() => "?").join(",")}) ORDER BY k`, ...ids),
  ]);

  const total = cnt.results[0].c;
  if (asCsv) {
    const head = "installed_at,recorded_at,app,package_name,device_id,country,install_count\n";
    const body = rows.results
      .map((r) => [r.installed_at, r.created_at, r.app, r.package_name, r.device_id, r.country, r.install_count].map(csvCell).join(","))
      .join("\n");
    return csvResponse(head + body);
  }

  return json({
    rows: rows.results,
    total,
    page,
    per_page: per,
    pages: Math.max(1, Math.ceil(total / per)),
    countries: cFacet.results.map((r) => r.k).filter(Boolean).sort(),
  });
}

function csvResponse(text) {
  return new Response(text, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="installs.csv"',
      "Cache-Control": "no-store",
    },
  });
}
