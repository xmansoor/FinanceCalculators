// api/gate.js - the whole server side of the sign-in, in one file.
//
//   { action: 'signup', name, email, consent, dataUse, website, turnstile }
//        checks the Cloudflare Turnstile token, saves the person, and returns a 30-day sign-in token
//
// Other endpoints (riskfree.js, erp.js) can be protected with:
//   const { requireUser } = require('./gate');
//   ...first line inside the handler:  if (!(await requireUser(req, res))) return;
//
// Environment variables needed in Vercel:
//   DATABASE_URL           added automatically by the Neon integration
//   GATE_SECRET            any random string of 32+ characters (keep the existing one, so current sign-ins stay valid)
//   TURNSTILE_SECRET_KEY   the Secret Key from your Cloudflare Turnstile widget
//   DAILY_LIMIT            optional: live-data requests per user per day (default 50)
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SESSION_DAYS = 30;
const SIGNUPS_PER_IP_PER_DAY = 20;

/* ---------- database ---------- */
let sql = null;
let ready = null;

function db() {
  if (!sql) sql = neon(process.env.DATABASE_URL);
  if (!ready) {
    ready = (async () => {
      await sql`create table if not exists users (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        email text not null unique,
        consent_terms_at timestamptz not null default now(),
        consent_data_use boolean not null default false,
        consent_data_use_at timestamptz,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now()
      )`;
      await sql`create table if not exists usage (
        key text not null,
        day date not null,
        count int not null default 0,
        primary key (key, day)
      )`;
      await sql`alter table users add column if not exists verified_at timestamptz`;
    })().catch((e) => {
      ready = null; // try again on the next request
      throw e;
    });
  }
  return ready.then(() => sql);
}

/* ---------- tokens and limits ---------- */
function secret() {
  const s = process.env.GATE_SECRET;
  if (!s || s.length < 32) throw new Error('GATE_SECRET is missing or shorter than 32 characters');
  return s;
}
const b64 = (v) => Buffer.from(v).toString('base64url');
const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + mac(body);
}

// purpose is 'session' (signed-in visitor)
function verify(token, purpose) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const want = Buffer.from(mac(parts[0]));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return p && p.p === purpose && p.exp > Date.now() ? p : null;
  } catch (e) {
    return null;
  }
}

// One-way hash, so IP addresses are never kept in readable form in the usage table.
const shortHash = (v) => crypto.createHash('sha256').update(v + secret()).digest('hex').slice(0, 32);
function getIp(req) {
  return (
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}
const ipHash = (req) => shortHash(getIp(req));

// Counts one use against a key for today. Returns false once the limit is passed.
async function hit(key, limit) {
  const s = await db();
  const rows = await s`
    insert into usage (key, day, count) values (${key}, current_date, 1)
    on conflict (key, day) do update set count = usage.count + 1
    returning count`;
  return rows[0].count <= limit;
}

// Guard for other /api endpoints. Returns the user, or null after sending a 401 or 429 reply.
async function requireUser(req, res) {
  const h = String(req.headers.authorization || '');
  const p = verify(h.startsWith('Bearer ') ? h.slice(7) : '', 'session');
  if (!p) {
    res.status(401).json({ error: 'sign_in_required' });
    return null;
  }
  const limit = parseInt(process.env.DAILY_LIMIT, 10) || 50;
  if (!(await hit('u:' + p.uid, limit))) {
    res.status(429).json({ error: 'daily_limit' });
    return null;
  }
  return p;
}

/* ---------- Cloudflare Turnstile ---------- */
// Asks Cloudflare whether the token from the visitor's browser is genuine.
// Each token works once and expires after a few minutes.
async function checkTurnstile(token, ip) {
  const key = process.env.TURNSTILE_SECRET_KEY;
  if (!key) throw new Error('TURNSTILE_SECRET_KEY is not set');
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new URLSearchParams();
  form.append('secret', key);
  form.append('response', token);
  if (ip && ip !== 'unknown') form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form
  });
  if (!r.ok) throw new Error('Turnstile replied ' + r.status);
  const j = await r.json();
  return j.success === true;
}

/* ---------- action: signup ---------- */
async function signup(b, req, res) {
  // Hidden field that real people never fill in; simple bots do.
  if (b.website) return res.status(400).json({ error: 'invalid' });

  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  if (name.length < 2 || !EMAIL.test(email)) return res.status(400).json({ error: 'invalid' });
  if (b.consent !== true) return res.status(400).json({ error: 'consent' });
  if (!b.turnstile) return res.status(400).json({ error: 'captcha' });

  // The bot check comes before the IP count, so bots without a valid token
  // cannot use up the sign-up allowance of real people on the same network.
  if (!(await checkTurnstile(b.turnstile, getIp(req)))) {
    return res.status(400).json({ error: 'captcha_failed' });
  }
  if (!(await hit('ip:' + ipHash(req), SIGNUPS_PER_IP_PER_DAY))) {
    return res.status(429).json({ error: 'too_many' });
  }

  const dataUse = b.dataUse === true;
  const consentAt = dataUse ? new Date().toISOString() : null;
  const s = await db();

  // New person: create them. Returning person (same email): refresh name and data-use choice.
  const rows = await s`
    insert into users (name, email, consent_data_use, consent_data_use_at)
    values (${name}, ${email}, ${dataUse}::boolean, ${consentAt}::timestamptz)
    on conflict (email) do update set
      name = excluded.name,
      last_seen_at = now(),
      consent_data_use_at = case
        when excluded.consent_data_use <> users.consent_data_use then now()
        else users.consent_data_use_at end,
      consent_data_use = excluded.consent_data_use
    returning id, consent_data_use`;

  const exp = Date.now() + SESSION_DAYS * 864e5;
  return res.status(200).json({
    token: sign({ p: 'session', uid: rows[0].id, exp }),
    uid: rows[0].id,
    exp,
    dataUse: rows[0].consent_data_use
  });
}

/* ---------- the endpoint ---------- */
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    return await signup(b, req, res);
  } catch (e) {
    console.error('gate error', e && e.message);
    return res.status(500).json({ error: 'server' });
  }
}

module.exports = handler;
module.exports.requireUser = requireUser;
