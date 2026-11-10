// Trip Planner API (Cloudflare Worker).
// Static files in ./public are served by Cloudflare directly; this script only
// handles /api/*. Every API call must carry a valid Cloudflare Access token
// (email one-time PIN login). No libraries.

const COLS = ['trips', 'flights', 'acts', 'hotels', 'expenses', 'packing'];
const MAX_BODY = 2000000; // bytes per request
const MAX_REC = 20000; // bytes per record
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const json = (o, status) =>
  new Response(JSON.stringify(o), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/* ---------- login check (Cloudflare Access JWT, RS256) ---------- */

let jwks = null;
let jwksAt = 0;

function b64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accessKeys(env, force) {
  if (!force && jwks && Date.now() - jwksAt < 3600000) return jwks;
  const r = await fetch(env.TEAM_DOMAIN + '/cdn-cgi/access/certs');
  if (!r.ok) throw new Error('certs');
  jwks = (await r.json()).keys || [];
  jwksAt = Date.now();
  return jwks;
}

function tokenOf(request) {
  const h = request.headers.get('Cf-Access-Jwt-Assertion');
  if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') || '');
  return m ? m[1] : '';
}

// Returns the signed-in email (lower case) or null.
async function whoIs(request, env) {
  const tok = tokenOf(request);
  const p = tok.split('.');
  if (p.length !== 3) return null;
  let head, body;
  try {
    head = JSON.parse(new TextDecoder().decode(b64u(p[0])));
    body = JSON.parse(new TextDecoder().decode(b64u(p[1])));
  } catch (e) {
    return null;
  }
  if (head.alg !== 'RS256' || !head.kid) return null;
  let key = (await accessKeys(env)).find((k) => k.kid === head.kid);
  if (!key) key = (await accessKeys(env, true)).find((k) => k.kid === head.kid);
  if (!key) return null;
  const ck = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', ck, b64u(p[2]), new TextEncoder().encode(p[0] + '.' + p[1]));
  if (!ok) return null;
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (aud.indexOf(env.POLICY_AUD) < 0) return null;
  if (body.iss !== env.TEAM_DOMAIN) return null;
  if (!(body.exp * 1000 > Date.now())) return null;
  if (typeof body.email !== 'string' || body.email.indexOf('@') < 1) return null;
  return body.email.trim().toLowerCase();
}

/* ---------- database ---------- */

let schemaReady = false;

async function schema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(
      'CREATE TABLE IF NOT EXISTS records (col TEXT NOT NULL, id TEXT NOT NULL, trip TEXT NOT NULL, data TEXT, u INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (col, id))'
    ),
    db.prepare('CREATE INDEX IF NOT EXISTS records_trip_seq ON records (trip, seq)'),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS members (trip TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (trip, email))'
    ),
    db.prepare('CREATE INDEX IF NOT EXISTS members_email ON members (email)'),
    db.prepare('CREATE TABLE IF NOT EXISTS counter (k TEXT PRIMARY KEY, n INTEGER NOT NULL)'),
    db.prepare("INSERT OR IGNORE INTO counter (k, n) VALUES ('seq', 0)"),
  ]);
  schemaReady = true;
}

const canEdit = (role) => role === 'owner' || role === 'editor';

/* ---------- sync ----------
   Request : { since, recs: { col: { id: record } }, dels: [ { k: "col/id", t, trip } ] }
   Response: { ok, email, cursor, recs: { col: { id: record } }, del: { "col/id": t }, roles: { tripId: role } }
   Merge rule (same as the app's import): the newest edit wins, and a deletion
   beats any edit that is older than it. */

async function sync(request, env, email) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too-big' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: 'bad-json' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'bad-json' }, 400);
  const db = env.DB;
  await schema(db);
  const since = Math.max(0, Math.floor(+body.since || 0));
  const now = Date.now();
  const clamp = (u) => Math.min(Math.floor(+u || 0), now + 300000);

  // 1. What this person may touch.
  const roles = {};
  (await db.prepare('SELECT trip, role FROM members WHERE email = ?1').bind(email).all()).results.forEach((r) => {
    roles[r.trip] = r.role;
  });

  // 2. Collect incoming records.
  const inRecs = [];
  const inc = body.recs && typeof body.recs === 'object' ? body.recs : {};
  COLS.forEach((c) => {
    const o = inc[c];
    if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach((id) => {
      const r = o[id];
      if (!ID_RE.test(id) || !r || typeof r !== 'object' || Array.isArray(r)) return;
      const trip = c === 'trips' ? id : r.trip;
      if (typeof trip !== 'string' || !ID_RE.test(trip)) return;
      const u = clamp(r._u);
      if (!(u > 0)) return;
      const data = JSON.stringify(Object.assign({}, r, { _u: u }));
      if (data.length > MAX_REC) return;
      inRecs.push({ c: c, i: id, t: trip, u: u, d: data });
    });
  });

  // 3. Trips this person does not belong to: brand new (they become the owner,
  //    as long as the trip itself is in this push) or somebody else's (ignored).
  const unknown = {};
  inRecs.forEach((r) => {
    if (!roles[r.t]) unknown[r.t] = 1;
  });
  const claim = [];
  const uk = Object.keys(unknown);
  if (uk.length) {
    const taken = {};
    (
      await db
        .prepare('SELECT DISTINCT trip FROM members WHERE trip IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(uk))
        .all()
    ).results.forEach((r) => {
      taken[r.trip] = 1;
    });
    uk.forEach((t) => {
      if (!taken[t] && inRecs.some((r) => r.c === 'trips' && r.i === t)) {
        claim.push(t);
        roles[t] = 'owner';
      }
    });
  }
  const okRecs = inRecs.filter((r) => canEdit(roles[r.t]));

  // 4. Incoming deletions. The trip comes from the stored row when there is one.
  const inDels = [];
  (Array.isArray(body.dels) ? body.dels : []).forEach((d) => {
    if (!d || typeof d.k !== 'string') return;
    const p = d.k.split('/');
    if (p.length !== 2 || COLS.indexOf(p[0]) < 0 || !ID_RE.test(p[1])) return;
    const t = clamp(d.t);
    if (!(t > 0)) return;
    inDels.push({ c: p[0], i: p[1], k: d.k, u: t, t: typeof d.trip === 'string' && ID_RE.test(d.trip) ? d.trip : '' });
  });
  let okDels = [];
  if (inDels.length) {
    const have = {};
    (
      await db
        .prepare("SELECT col || '/' || id AS k, trip FROM records WHERE col || '/' || id IN (SELECT value FROM json_each(?1))")
        .bind(JSON.stringify(inDels.map((d) => d.k)))
        .all()
    ).results.forEach((r) => {
      have[r.k] = r.trip;
    });
    okDels = inDels.filter((d) => {
      if (have[d.k]) d.t = have[d.k];
      if (!d.t) return false;
      // Only the owner may delete the trip itself.
      return d.c === 'trips' ? roles[d.t] === 'owner' : canEdit(roles[d.t]);
    });
  }

  // 5. Write and read back in one transaction.
  const st = [];
  const writes = okRecs.length || okDels.length || claim.length;
  if (writes) st.push(db.prepare("UPDATE counter SET n = n + 1 WHERE k = 'seq'"));
  if (claim.length)
    st.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO members (trip, email, role, seq) SELECT value, ?2, 'owner', (SELECT n FROM counter WHERE k = 'seq') FROM json_each(?1)"
        )
        .bind(JSON.stringify(claim), email)
    );
  if (okRecs.length)
    st.push(
      db
        .prepare(
          "INSERT INTO records (col, id, trip, data, u, del, seq) SELECT json_extract(value, '$.c'), json_extract(value, '$.i'), json_extract(value, '$.t'), json_extract(value, '$.d'), json_extract(value, '$.u'), 0, (SELECT n FROM counter WHERE k = 'seq') FROM json_each(?1) WHERE true ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, u = excluded.u, del = 0, seq = excluded.seq WHERE excluded.u > records.u AND records.trip = excluded.trip"
        )
        .bind(JSON.stringify(okRecs))
    );
  if (okDels.length)
    st.push(
      db
        .prepare(
          "INSERT INTO records (col, id, trip, data, u, del, seq) SELECT json_extract(value, '$.c'), json_extract(value, '$.i'), json_extract(value, '$.t'), NULL, json_extract(value, '$.u'), 1, (SELECT n FROM counter WHERE k = 'seq') FROM json_each(?1) WHERE true ON CONFLICT (col, id) DO UPDATE SET data = NULL, u = excluded.u, del = 1, seq = excluded.seq WHERE excluded.u > records.u AND records.trip = excluded.trip"
        )
        .bind(JSON.stringify(okDels))
    );
  const iRoles = st.length;
  st.push(db.prepare('SELECT trip, role FROM members WHERE email = ?1').bind(email));
  // Everything changed since the caller's cursor, plus the whole of any trip
  // the caller was added to since then.
  st.push(
    db
      .prepare(
        "SELECT col, id, data, u, del FROM records WHERE trip IN (SELECT trip FROM members WHERE email = ?1) AND (seq > ?2 OR trip IN (SELECT trip FROM members WHERE email = ?1 AND seq > ?2)) AND NOT (col = 'expenses' AND trip IN (SELECT trip FROM members WHERE email = ?1 AND role = 'viewer-nb'))"
      )
      .bind(email, since)
  );
  st.push(db.prepare("SELECT n FROM counter WHERE k = 'seq'"));
  const res = await db.batch(st);

  const out = { ok: true, email: email, cursor: 0, recs: {}, del: {}, roles: {} };
  res[iRoles].results.forEach((r) => {
    out.roles[r.trip] = r.role;
  });
  res[iRoles + 1].results.forEach((r) => {
    if (r.del) out.del[r.col + '/' + r.id] = r.u;
    else {
      try {
        const d = JSON.parse(r.data);
        // "View only, budget hidden": the trip's total budget is not sent either.
        if (r.col === 'trips' && out.roles[r.id] === 'viewer-nb') delete d.budget;
        (out.recs[r.col] = out.recs[r.col] || {})[r.id] = d;
      } catch (e) {}
    }
  });
  const n = res[iRoles + 2].results[0];
  out.cursor = n ? n.n : 0;
  return json(out);
}

/* ---------- sharing ----------
   GET  /api/share?trip=ID                      -> who is on the trip
   POST /api/share { trip, email, role }        -> owner adds a person or changes what they can do
   POST /api/share { trip, email, role: '' }    -> owner removes a person
   POST /api/share { trip, leave: true }        -> a person who is not the owner leaves
   Roles: owner, editor, viewer, viewer-nb (view only, budget hidden). */

const SHARE_ROLES = ['editor', 'viewer', 'viewer-nb'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_MEMBERS = 20;

async function memberList(db, trip, mine) {
  if (mine !== 'owner' && mine !== 'editor') return [];
  return (await db.prepare("SELECT email, role FROM members WHERE trip = ?1 ORDER BY role = 'owner' DESC, email").bind(trip).all()).results;
}

async function share(request, env, email, url) {
  const db = env.DB;
  await schema(db);
  let body = null;
  if (request.method === 'POST') {
    try {
      body = JSON.parse(await request.text());
    } catch (e) {
      return json({ error: 'bad-json' }, 400);
    }
    if (!body || typeof body !== 'object') return json({ error: 'bad-json' }, 400);
  }
  const trip = body ? body.trip : url.searchParams.get('trip');
  if (typeof trip !== 'string' || !ID_RE.test(trip)) return json({ error: 'bad-trip' }, 400);
  const me = (await db.prepare('SELECT role FROM members WHERE trip = ?1 AND email = ?2').bind(trip, email).all()).results[0];
  if (!me) return json({ error: 'not-found' }, 404);
  const done = async (extra) => json(Object.assign({ ok: true, role: me.role, members: await memberList(db, trip, me.role) }, extra || {}));
  if (!body) return done();

  if (body.leave === true) {
    if (me.role === 'owner') return json({ ok: false, error: 'owner-cannot-leave' });
    await db.prepare("DELETE FROM members WHERE trip = ?1 AND email = ?2 AND role <> 'owner'").bind(trip, email).all();
    return json({ ok: true, left: true });
  }
  if (me.role !== 'owner') return json({ error: 'forbidden' }, 403);
  const who = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(who)) return done({ ok: false, error: 'bad-email' });
  if (who === email) return done({ ok: false, error: 'self' });
  if (body.role === '' || body.role == null) {
    await db.prepare("DELETE FROM members WHERE trip = ?1 AND email = ?2 AND role <> 'owner'").bind(trip, who).all();
    return done();
  }
  if (SHARE_ROLES.indexOf(body.role) < 0) return done({ ok: false, error: 'bad-role' });
  const cnt = (await db.prepare('SELECT COUNT(*) AS n FROM members WHERE trip = ?1 AND email <> ?2').bind(trip, who).all()).results[0].n;
  if (cnt >= MAX_MEMBERS) return done({ ok: false, error: 'limit' });
  // A new sequence number makes the person's next sync fetch the whole trip.
  await db.batch([
    db.prepare("UPDATE counter SET n = n + 1 WHERE k = 'seq'"),
    db
      .prepare(
        "INSERT INTO members (trip, email, role, seq) VALUES (?1, ?2, ?3, (SELECT n FROM counter WHERE k = 'seq')) ON CONFLICT (trip, email) DO UPDATE SET role = excluded.role, seq = excluded.seq WHERE members.role <> 'owner'"
      )
      .bind(trip, who, body.role),
  ]);
  return done();
}

/* ---------- routing ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.indexOf('/api/') !== 0) return env.ASSETS.fetch(request);
    try {
      if (!env.POLICY_AUD || !env.TEAM_DOMAIN || !env.DB) return json({ error: 'not-configured' }, 503);
      const email = await whoIs(request, env);
      if (url.pathname === '/api/login') {
        // Cloudflare Access shows its login page before this is reached.
        if (!email) return new Response('Sign-in did not complete. Please go back and try again.', { status: 401 });
        return new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } });
      }
      if (!email) return json({ error: 'signed-out' }, 401);
      if (url.pathname === '/api/me' && request.method === 'GET') return json({ ok: true, email: email });
      if (url.pathname === '/api/sync' && request.method === 'POST') return await sync(request, env, email);
      if (url.pathname === '/api/share' && (request.method === 'GET' || request.method === 'POST')) return await share(request, env, email, url);
      return json({ error: 'not-found' }, 404);
    } catch (e) {
      return json({ error: 'server', message: String((e && e.message) || e) }, 500);
    }
  },
};
