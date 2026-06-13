/**
 * Road Rant — Cloudflare Worker
 *
 * Environment variables (Cloudflare dashboard):
 *   ALLOWED_ORIGINS  — Comma-separated allowed origins
 *
 * KV Namespace binding:
 *   ROAD_RANT_KV     — KV namespace for all user data
 *
 * Routes:
 *   GET    /                          Health check
 *   GET    /ping                      Health check
 *   POST   /auth/google               Verify Google ID token
 *   POST   /auth/verify               Re-verify stored Google credential
 *   POST   /auth/migrate              Token → Google one-way migration
 *   GET    /storage/:token/:key       Read KV value
 *   PUT    /storage/:token/:key       Write KV value
 *   DELETE /storage/:token/:key       Delete KV value
 *   GET    /storage/:token            List keys for token
 *   PUT    /username/:username        Register username → token
 *   GET    /username/:username        Look up token by username
 *   DELETE /username/:username        Remove username (own token only)
 *   POST   /notify/:targetToken       Write notification to another user
 *   GET    /plates/:state/:plate      List public incidents for a plate
 *   PUT    /plates/:state/:plate/:id  Index a public incident by plate
 *   DELETE /plates/:state/:plate/:id  Remove incident from plate index
 */

const GOOGLE_CLIENT_ID = ''; // Set your Google OAuth Client ID here

const KV_BINDING        = 'ROAD_RANT_KV';
const KV_TTL            = 60 * 60 * 24 * 1825; // 5 years
const HMAC_SALT         = 'road-rant-hmac-v1';
const MAX_BODY_SIZE     = 64 * 1024;
const RATE_LIMIT        = 60;
const RATE_LIMIT_WINDOW = 60;

const SEVERITY_TIERS = {
  'road-rage':          'critical',
  'reckless-driving':   'critical',
  'impaired-driving':   'critical',
  'tailgating':         'serious',
  'unsafe-lane-change': 'serious',
  'distracted-driving': 'serious',
  'failure-to-yield':   'moderate',
  'illegal-passing':    'moderate',
  'horn-gestures':      'moderate',
  'parking-violation':  'minor',
};

// ── Response helpers ──────────────────────────────────────────────

function respond(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

// ── CORS ──────────────────────────────────────────────────────────

function buildCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Timestamp, X-Signature',
    'Vary':          'Origin',
    'Cache-Control': 'no-store',
  };
}

function checkOrigin(request, allowed) {
  const origin = request.headers.get('Origin') || '';
  return allowed.includes(origin) ? origin : null;
}

// ── Token validation ──────────────────────────────────────────────

function isValidToken(token) {
  return /^(google:\d{10,30}|[a-zA-Z0-9_-]{8,128})$/.test(token);
}

// ── HMAC signing ──────────────────────────────────────────────────

async function deriveHmacKey(token) {
  const enc = new TextEncoder();
  const km  = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HMAC_SALT), info: enc.encode('request-signing') },
    km, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function verifyHmac(request, token, body) {
  const ts  = request.headers.get('X-Timestamp') || '';
  const sig = request.headers.get('X-Signature') || '';
  if (!ts || !sig) return { ok: false, reason: 'Missing HMAC headers' };
  if (Math.abs(Date.now() - parseInt(ts, 10)) > 5 * 60 * 1000) return { ok: false, reason: 'Timestamp expired' };

  const enc      = new TextEncoder();
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body || ''))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const message = `${request.method.toUpperCase()}:${token}:${ts}:${bodyHash}`;

  try {
    const key      = await deriveHmacKey(token);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(message));
    return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
  } catch { return { ok: false, reason: 'Verification error' }; }
}

async function checkKvAuth(request, token, cors, body) {
  if (token.startsWith('google:')) {
    const auth    = request.headers.get('Authorization') || '';
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!idToken) return { ok: false, response: respond(JSON.stringify({ error: 'Authorization required' }), 401, cors) };
    const payload = await verifyGoogleJWT(idToken);
    if (!payload) return { ok: false, response: respond(JSON.stringify({ error: 'Invalid Google token' }), 401, cors) };
    if (token !== `google:${payload.sub}`) return { ok: false, response: respond(JSON.stringify({ error: 'Token mismatch' }), 403, cors) };
    return { ok: true };
  }
  const hmac = await verifyHmac(request, token, body);
  if (!hmac.ok) return { ok: false, response: respond(JSON.stringify({ error: `HMAC: ${hmac.reason}` }), 401, cors) };
  return { ok: true };
}

// ── Google JWT ────────────────────────────────────────────────────

async function verifyGoogleJWT(idToken) {
  if (!GOOGLE_CLIENT_ID) return null;
  try {
    const parts   = idToken.split('.');
    if (parts.length !== 3) return null;
    const header  = JSON.parse(atob(parts[0].replace(/-/g,'+').replace(/_/g,'/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp < now || payload.aud !== GOOGLE_CLIENT_ID || !payload.sub) return null;
    if (!['accounts.google.com','https://accounts.google.com'].includes(payload.iss)) return null;

    const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!jwksRes.ok) return null;
    const jwks    = await jwksRes.json();
    const jwk     = jwks.keys?.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;

    return { sub: payload.sub, email: payload.email || null, name: payload.name || null, picture: payload.picture || null };
  } catch { return null; }
}

// ── Auth routes ───────────────────────────────────────────────────

async function handleAuth(url, method, request, env, cors) {
  const kv = env[KV_BINDING];

  if (url.pathname === '/auth/google' && method === 'POST') {
    let body; try { body = await request.json(); } catch { return respond(JSON.stringify({ error: 'Bad body' }), 400, cors); }
    const payload = await verifyGoogleJWT(body.idToken);
    if (!payload) return respond(JSON.stringify({ error: 'Invalid Google token' }), 401, cors);
    return respond(JSON.stringify({ ok: true, kvKey: `google:${payload.sub}`, profile: payload }), 200, cors);
  }

  if (url.pathname === '/auth/verify' && method === 'POST') {
    let body; try { body = await request.json(); } catch { return respond(JSON.stringify({ error: 'Bad body' }), 400, cors); }
    const payload = await verifyGoogleJWT(body.idToken);
    if (!payload) return respond(JSON.stringify({ ok: false, error: 'Token expired' }), 401, cors);
    return respond(JSON.stringify({ ok: true, profile: payload }), 200, cors);
  }

  if (url.pathname === '/auth/migrate' && method === 'POST') {
    let body; try { body = await request.json(); } catch { return respond(JSON.stringify({ error: 'Bad body' }), 400, cors); }
    const { idToken, oldToken } = body || {};
    if (!idToken || !oldToken || !isValidToken(oldToken)) return respond(JSON.stringify({ error: 'idToken and valid oldToken required' }), 400, cors);
    const payload = await verifyGoogleJWT(idToken);
    if (!payload) return respond(JSON.stringify({ error: 'Invalid Google token' }), 401, cors);
    const existing = await kv.get(`user:${oldToken}:profile`, { type: 'text' });
    if (!existing) return respond(JSON.stringify({ error: 'Source account not found' }), 404, cors);
    let parsed; try { parsed = JSON.parse(existing); } catch { return respond(JSON.stringify({ error: 'Corrupt data' }), 500, cors); }
    const kvKey = `google:${payload.sub}`;
    parsed.authMethod = 'google'; parsed.linkedGoogle = payload; parsed.lastModified = Date.now();
    await kv.put(kvKey, JSON.stringify(parsed), { expirationTtl: KV_TTL });
    await kv.put(`migrated:${oldToken}`, kvKey, { expirationTtl: 60 * 60 * 24 * 90 });
    return respond(JSON.stringify({ ok: true, kvKey, profile: payload }), 200, cors);
  }

  return null;
}

// ── Storage ───────────────────────────────────────────────────────

async function handleStorage(request, env, pathname, cors) {
  const kv    = env[KV_BINDING];
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Token required' }), 400, cors);

  const token = parts[1];
  if (!isValidToken(token)) return respond(JSON.stringify({ error: 'Invalid token' }), 400, cors);

  const rlErr = await rateLimit(token, env, cors);
  if (rlErr) return rlErr;

  // List keys
  if (parts.length === 2 && request.method === 'GET') {
    const prefix = `user:${token}:`;
    const list   = await kv.list({ prefix });
    return respond(JSON.stringify({
      keys: list.keys.map(k => ({ key: k.name.slice(prefix.length), expiration: k.expiration })),
      list_complete: list.list_complete,
    }), 200, cors);
  }

  if (parts.length < 3) return respond(JSON.stringify({ error: 'Key required' }), 400, cors);
  const userKey = parts.slice(2).join('/');
  if (!/^[a-zA-Z0-9_\-./]{1,256}$/.test(userKey)) return respond(JSON.stringify({ error: 'Invalid key' }), 400, cors);
  const kvKey = `user:${token}:${userKey}`;

  if (request.method === 'GET') {
    const auth = await checkKvAuth(request, token, cors, null);
    if (!auth.ok) return auth.response;
    // Migration tombstone
    const tomb = await kv.get(`migrated:${token}`, { type: 'text' });
    if (tomb) return respond(JSON.stringify({ migrated: true }), 410, { ...cors, 'X-Account-Migrated': 'google' });
    // Legacy forward
    const fwd = await kv.get(`legacy:${token}`, { type: 'text' });
    if (fwd) {
      const newData = await kv.get(fwd, { type: 'text' });
      if (newData) return respond(newData, 200, { ...cors, 'X-Token-Migrated': fwd });
    }
    const value = await kv.get(kvKey, { type: 'text' });
    if (value === null) return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    return respond(JSON.stringify({ value: JSON.parse(value) }), 200, cors);
  }

  if (request.method === 'PUT') {
    const bodyText = await readBodyText(request);
    if (!bodyText) return respond(JSON.stringify({ error: 'Invalid or oversized body' }), 400, cors);
    let parsed; try { parsed = JSON.parse(bodyText); } catch { return respond(JSON.stringify({ error: 'Invalid JSON' }), 400, cors); }
    const auth = await checkKvAuth(request, token, cors, bodyText);
    if (!auth.ok) return auth.response;
    // Legacy pointer
    if (parsed._legacyToken && isValidToken(parsed._legacyToken) && parsed._legacyToken !== token) {
      await kv.put(`legacy:${parsed._legacyToken}`, token, { expirationTtl: 60 * 60 * 24 * 90 });
    }
    delete parsed._legacyToken;
    await kv.put(kvKey, JSON.stringify(parsed), { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  if (request.method === 'DELETE') {
    const auth = await checkKvAuth(request, token, cors, null);
    if (!auth.ok) return auth.response;
    await kv.delete(kvKey);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

// ── Username registry ─────────────────────────────────────────────

async function handleUsername(request, env, pathname, cors) {
  const kv       = env[KV_BINDING];
  const parts    = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Username required' }), 400, cors);
  const username = parts[1].toLowerCase().trim();
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return respond(JSON.stringify({ error: 'Invalid username format' }), 400, cors);
  const kvKey = `username:${username}`;

  if (request.method === 'GET') {
    const val = await kv.get(kvKey, { type: 'text' });
    if (!val) return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    return respond(val, 200, cors);
  }

  if (request.method === 'PUT') {
    const body = await readBody(request);
    if (!body?.token || !isValidToken(body.token)) return respond(JSON.stringify({ error: 'Valid token required' }), 400, cors);
    const existing = await kv.get(kvKey, { type: 'text' });
    if (existing && JSON.parse(existing).token !== body.token) return respond(JSON.stringify({ error: 'Username taken' }), 409, cors);
    const revKey = `token_username:${body.token}`;
    const old    = await kv.get(revKey, { type: 'text' });
    if (old && old !== username) await kv.delete(`username:${old}`);
    await kv.put(kvKey,  JSON.stringify({ token: body.token, username }), { expirationTtl: KV_TTL });
    await kv.put(revKey, username, { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  if (request.method === 'DELETE') {
    const body = await readBody(request);
    if (!body?.token) return respond(JSON.stringify({ error: 'token required' }), 400, cors);
    const existing = await kv.get(kvKey, { type: 'text' });
    if (!existing) return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    if (JSON.parse(existing).token !== body.token) return respond(JSON.stringify({ error: 'Not your username' }), 403, cors);
    await kv.delete(kvKey);
    await kv.delete(`token_username:${body.token}`);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

// ── Notifications ─────────────────────────────────────────────────

async function handleNotify(request, env, pathname, cors) {
  const kv    = env[KV_BINDING];
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Target token required' }), 400, cors);
  const targetToken = parts[1];
  if (!isValidToken(targetToken)) return respond(JSON.stringify({ error: 'Invalid token' }), 400, cors);

  const body = await readBody(request);
  if (!body) return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors);
  const { entryId, fromUsername, fromToken, preview } = body;
  if (!entryId || !fromUsername || !fromToken) return respond(JSON.stringify({ error: 'entryId, fromUsername, fromToken required' }), 400, cors);

  const storedUsername = await kv.get(`token_username:${fromToken}`, { type: 'text' });
  if (!storedUsername || storedUsername.toLowerCase() !== fromUsername.toLowerCase()) {
    return respond(JSON.stringify({ error: 'fromToken/fromUsername mismatch' }), 403, cors);
  }

  await kv.put(
    `user:${targetToken}:notification/${entryId}`,
    JSON.stringify({ entryId, fromUsername, fromToken, preview: (preview||'').slice(0,200), createdAt: new Date().toISOString() }),
    { expirationTtl: KV_TTL }
  );
  return respond(JSON.stringify({ ok: true }), 200, cors);
}

// ── Plate index (chalk-line) ──────────────────────────────────────
//
// KV key: plate:{STATE}:{PLATE}
// Value:  { incidents: [{id, token, username, lat, lng, incidentType, severity, datetime, visibility}] }
//
// Only non-private incidents are indexed. Max 500 per plate, newest first.

async function handlePlates(request, env, pathname, cors) {
  const kv    = env[KV_BINDING];
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3) return respond(JSON.stringify({ error: 'State and plate required' }), 400, cors);

  const state = parts[1].toUpperCase();
  const plate = parts[2].toUpperCase().replace(/\s+/g, '');
  const id    = parts[3] || null;

  if (!/^[A-Z]{2}$/.test(state))        return respond(JSON.stringify({ error: 'Invalid state' }), 400, cors);
  if (!/^[A-Z0-9]{1,10}$/.test(plate))  return respond(JSON.stringify({ error: 'Invalid plate' }), 400, cors);

  const plateKey = `plate:${state}:${plate}`;

  // GET — fetch incident index for this plate
  if (request.method === 'GET' && !id) {
    const raw = await kv.get(plateKey, { type: 'text' });
    return respond(raw || JSON.stringify({ incidents: [] }), 200, cors);
  }

  // PUT — add/update incident in plate index
  if (request.method === 'PUT' && id) {
    const body = await readBody(request);
    if (!body) return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors);
    const { token, username, lat, lng, incidentType, datetime, visibility } = body;
    if (!token || !lat || !lng || !incidentType || !datetime) {
      return respond(JSON.stringify({ error: 'token, lat, lng, incidentType, datetime required' }), 400, cors);
    }
    if (visibility === 'private') return respond(JSON.stringify({ error: 'Private incidents cannot be indexed' }), 403, cors);

    let index = { incidents: [] };
    const raw = await kv.get(plateKey, { type: 'text' });
    if (raw) { try { index = JSON.parse(raw); } catch { index = { incidents: [] }; } }

    index.incidents = index.incidents.filter(i => i.id !== id);
    index.incidents.push({ id, token, username: username || null, lat, lng, incidentType,
      severity: SEVERITY_TIERS[incidentType] || 'moderate', datetime, visibility });
    index.incidents.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
    index.incidents = index.incidents.slice(0, 500);

    await kv.put(plateKey, JSON.stringify(index), { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  // DELETE — remove incident from plate index
  if (request.method === 'DELETE' && id) {
    const body = await readBody(request);
    if (!body?.token) return respond(JSON.stringify({ error: 'token required' }), 400, cors);
    const raw = await kv.get(plateKey, { type: 'text' });
    if (!raw) return respond(JSON.stringify({ ok: true }), 200, cors);
    let index; try { index = JSON.parse(raw); } catch { return respond(JSON.stringify({ ok: true }), 200, cors); }
    const incident = index.incidents.find(i => i.id === id);
    if (incident && incident.token !== body.token) return respond(JSON.stringify({ error: 'Not your incident' }), 403, cors);
    index.incidents = index.incidents.filter(i => i.id !== id);
    await kv.put(plateKey, JSON.stringify(index), { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

// ── Rate limiter ──────────────────────────────────────────────────

async function rateLimit(token, env, cors) {
  const kv          = env[KV_BINDING];
  const rlKey       = `ratelimit:${token}`;
  const now         = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW;
  let ts = [];
  const stored = await kv.get(rlKey, { type: 'text' });
  if (stored) { try { ts = JSON.parse(stored).filter(t => t > windowStart); } catch {} }
  if (ts.length >= RATE_LIMIT) return respond(JSON.stringify({ error: 'Rate limit exceeded' }), 429, cors);
  ts.push(now);
  await kv.put(rlKey, JSON.stringify(ts), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
  return null;
}

// ── Body helpers ──────────────────────────────────────────────────

async function readBody(request) {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) return null;
    return JSON.parse(text);
  } catch { return null; }
}

async function readBodyText(request) {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) return null;
    JSON.parse(text); // validate
    return text;
  } catch { return null; }
}

// ── Entry point ───────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    const origin = checkOrigin(request, allowedOrigins);

    // OPTIONS preflight must be handled before origin enforcement so it's never blocked
    if (method === 'OPTIONS') {
      const corsOrigin = origin || allowedOrigins[0] || '*';
      return new Response(null, { status: 204, headers: buildCorsHeaders(corsOrigin) });
    }

    // Health check — no auth, but include CORS so cross-origin fetch() sees res.ok = true
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      const corsHeaders = origin ? buildCorsHeaders(origin) : { 'Access-Control-Allow-Origin': '*' };
      return new Response(JSON.stringify({ ok: true, app: 'road-rant', ts: Date.now() }), {
        status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
      });
    }

    if (!origin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    const cors = buildCorsHeaders(origin);

    try {
      const authRes = await handleAuth(url, method, request, env, cors);
      if (authRes) return authRes;

      const path = url.pathname.replace(/\/$/, '');

      if (path.startsWith('/storage/'))  return await handleStorage(request, env, path, cors);
      if (path.startsWith('/username/')) return await handleUsername(request, env, path, cors);
      if (path.startsWith('/notify/') && method === 'POST') return await handleNotify(request, env, path, cors);
      if (path.startsWith('/plates/'))   return await handlePlates(request, env, path, cors);

      return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    } catch (err) {
      console.error('Unhandled error:', err);
      return respond(JSON.stringify({ error: 'Internal server error' }), 500, cors);
    }
  },
};
