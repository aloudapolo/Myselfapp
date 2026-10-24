// API du dashboard : un petit magasin de documents (D1) protégé par un code.
// Les pages de public/ sont servies par le binding ASSETS ; seul /api/* passe ici.

const PBKDF2_ITERATIONS = 60000;
const SESSION_DAYS = 400;
const MAX_BODY = 900 * 1024;
const MAX_LIST = 1000;
const SEG = "[A-Za-z0-9_\\-.~:@+]{1,200}";
const PATH_RE = new RegExp(`^${SEG}(?:/${SEG}){0,15}$`);

const enc = new TextEncoder();
let ready = false;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
const fail = (status, error) => json({ error }, status);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function pbkdf2(code, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256));
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, created_at INTEGER NOT NULL)"),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)",
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS docs_col ON docs(col)"),
  ]);
  ready = true;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("too_large");
  return text ? JSON.parse(text) : {};
}

async function newSession(db) {
  const token = randomHex(32);
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE created_at < ?").bind(now - SESSION_DAYS * 864e5),
    db.prepare("INSERT INTO sessions (h, created_at) VALUES (?, ?)").bind(await sha256(token), now),
  ]);
  return token;
}

async function isAuthed(request, db) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") || "");
  if (!m) return false;
  const row = await db.prepare("SELECT created_at FROM sessions WHERE h = ?").bind(await sha256(m[1])).first();
  return !!row && Date.now() - row.created_at < SESSION_DAYS * 864e5;
}

const validCode = (c) => typeof c === "string" && c.length >= 8 && c.length <= 128;

async function handleAuth(request, db, route) {
  if (route === "status") {
    const row = await db.prepare("SELECT 1 AS x FROM meta WHERE k = 'auth'").first();
    return json({ configured: !!row });
  }
  if (route === "logout") {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") || "");
    if (m) await db.prepare("DELETE FROM sessions WHERE h = ?").bind(await sha256(m[1])).run();
    return json({ ok: true });
  }
  let body;
  try { body = await readJson(request); } catch { return fail(400, "bad_request"); }
  if (!validCode(body.code)) return fail(400, "code_invalid");

  if (route === "setup") {
    const salt = randomHex(16);
    const record = JSON.stringify({ salt, hash: await pbkdf2(body.code, salt) });
    const res = await db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('auth', ?)").bind(record).run();
    if (!res.meta.changes) return fail(409, "already_configured");
    return json({ token: await newSession(db) });
  }

  // login : 5 essais ratés = 1 minute de pause
  const authRow = await db.prepare("SELECT v FROM meta WHERE k = 'auth'").first();
  if (!authRow) return fail(409, "not_configured");
  const failsRow = await db.prepare("SELECT v FROM meta WHERE k = 'fails'").first();
  const fails = failsRow ? JSON.parse(failsRow.v) : { n: 0, until: 0 };
  const now = Date.now();
  if (fails.until > now) return json({ error: "locked", retryIn: Math.ceil((fails.until - now) / 1000) }, 429);
  const { salt, hash } = JSON.parse(authRow.v);
  if (!sameString(await pbkdf2(body.code, salt), hash)) {
    fails.n += 1;
    if (fails.n >= 5) { fails.n = 0; fails.until = now + 60000; }
    await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('fails', ?)").bind(JSON.stringify(fails)).run();
    return fail(401, "wrong_code");
  }
  await db.prepare("DELETE FROM meta WHERE k = 'fails'").run();
  return json({ token: await newSession(db) });
}

async function handleDocs(request, db, route, url) {
  const path = url.searchParams.get("path") || "";
  if (!PATH_RE.test(path)) return fail(400, "bad_path");
  const parts = path.split("/");

  if (route === "col") {
    if (parts.length % 2 === 0) return fail(400, "not_a_collection");
    const { results } = await db
      .prepare("SELECT id, data, version, updated_at FROM docs WHERE col = ? ORDER BY updated_at DESC LIMIT ?")
      .bind(path, MAX_LIST)
      .all();
    return json(results.map((r) => ({ id: r.id, data: JSON.parse(r.data), version: r.version, updatedAt: r.updated_at })));
  }

  if (parts.length % 2 === 1) return fail(400, "not_a_document");
  const id = parts.pop();
  const col = parts.join("/");

  if (request.method === "GET") {
    const r = await db.prepare("SELECT data, version, updated_at FROM docs WHERE path = ?").bind(path).first();
    return r ? json({ id, data: JSON.parse(r.data), version: r.version, updatedAt: r.updated_at }) : fail(404, "not_found");
  }
  if (request.method === "DELETE") {
    await db.prepare("DELETE FROM docs WHERE path = ?").bind(path).run();
    return json({ ok: true });
  }
  if (request.method === "PUT") {
    let body;
    try { body = await readJson(request); } catch (e) { return fail(e.message === "too_large" ? 413 : 400, "bad_body"); }
    if (body.data === null || typeof body.data !== "object" || Array.isArray(body.data)) return fail(400, "data_must_be_object");
    const now = Date.now();
    if (body.ifVersion !== undefined) {
      const cur = await db.prepare("SELECT version FROM docs WHERE path = ?").bind(path).first();
      if ((cur ? cur.version : 0) !== body.ifVersion) return json({ error: "version_conflict", version: cur ? cur.version : 0 }, 409);
    }
    await db
      .prepare(
        "INSERT INTO docs (path, col, id, data, version, updated_at) VALUES (?, ?, ?, ?, 1, ?) " +
          "ON CONFLICT(path) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at",
      )
      .bind(path, col, id, JSON.stringify(body.data), now)
      .run();
    const r = await db.prepare("SELECT version FROM docs WHERE path = ?").bind(path).first();
    return json({ ok: true, version: r.version, updatedAt: now });
  }
  return fail(405, "method_not_allowed");
}

// Chiffres Binvio : lecture seule, uniquement des totaux (aucune coordonnée de client n'est renvoyée).
async function binvioSummary(db) {
  const out = { generatedAt: new Date().toISOString() };
  const one = (sql) => db.prepare(sql).first();
  const all = async (sql) => (await db.prepare(sql).all()).results;
  const section = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: "lecture_impossible" }; } };

  await section("demandes", async () => {
    const t = await one("SELECT COUNT(*) AS total, SUM(statut = 'nouvelle') AS nouvelles, SUM(substr(recue_le, 1, 10) >= date('now', '-7 day')) AS semaine FROM demandes");
    const last = await all("SELECT id, etab, recue_le, statut FROM demandes ORDER BY id DESC LIMIT 5");
    return { total: t.total || 0, nouvelles: t.nouvelles || 0, semaine: t.semaine || 0, dernieres: last };
  });
  await section("comptes", async () => {
    const t = await one("SELECT COUNT(*) AS total, SUM(statut = 'actif') AS actifs FROM comptes WHERE test = 0");
    const f = await all("SELECT formule, COUNT(*) AS n FROM comptes WHERE test = 0 AND statut = 'actif' GROUP BY formule");
    return { total: t.total || 0, actifs: t.actifs || 0, parFormule: Object.fromEntries(f.map((r) => [r.formule, r.n])) };
  });
  await section("factures", async () => {
    const net = "(montant_centimes - COALESCE(remise_centimes, 0))";
    const r = await all(`SELECT payee, COUNT(*) AS n, COALESCE(SUM(${net}), 0) AS centimes FROM factures GROUP BY payee`);
    const get = (p) => { const x = r.find((v) => v.payee === p); return { n: x ? x.n : 0, centimes: x ? x.centimes : 0 }; };
    const m = await one(`SELECT COALESCE(SUM(${net}), 0) AS centimes FROM factures WHERE payee = 1 AND substr(COALESCE(paye_le, date_facture), 1, 7) = strftime('%Y-%m', 'now')`);
    const rel = await all(`SELECT f.id, f.numero, c.entreprise AS entreprise, ${net} AS centimes, f.date_facture AS dateFacture,
      (substr(f.date_facture, 1, 10) <= date('now', '-7 day')) AS aRelancer
      FROM factures f LEFT JOIN comptes c ON c.id = f.compte_id WHERE f.payee = 0 ORDER BY f.id DESC LIMIT 30`);
    return { payees: get(1), impayees: get(0), encaisseMois: m ? m.centimes : 0, relances: rel.map((x) => ({ ...x, aRelancer: !!x.aRelancer })) };
  });
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const route = url.pathname.slice(5).replace(/\/+$/, "");
    try {
      await init(env.DB);
      if (["status", "setup", "login", "logout"].includes(route)) {
        if (route !== "status" && request.method !== "POST") return fail(405, "method_not_allowed");
        return await handleAuth(request, env.DB, route);
      }
      if (route === "doc" || route === "col") {
        if (!(await isAuthed(request, env.DB))) return fail(401, "unauthorized");
        return await handleDocs(request, env.DB, route, url);
      }
      if (route === "binvio") {
        if (!(await isAuthed(request, env.DB))) return fail(401, "unauthorized");
        if (!env.BINVIO) return fail(503, "binvio_not_connected");
        return json(await binvioSummary(env.BINVIO));
      }
      return fail(404, "not_found");
    } catch (e) {
      return fail(500, "server_error");
    }
  },
};
