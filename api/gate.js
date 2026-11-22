// api/gate.js - the whole server side of the sign-in, in one file.
//
//   { action: 'signup', name, email, consent, dataUse, website }
//        saves the person as unconfirmed and emails them a link that works for 30 minutes
//   { action: 'confirm', t }
//        t is the token from the emailed link; marks the email confirmed and returns a 30-day sign-in token
//
// Other endpoints (riskfree.js, erp.js) can be protected with:
//   const { requireUser } = require('./gate');
//   ...first line inside the handler:  if (!(await requireUser(req, res))) return;
//
// Environment variables needed in Vercel:
//   DATABASE_URL     added automatically by the Neon integration
//   GATE_SECRET      any random string of 32+ characters
//   RESEND_API_KEY   your Resend API key
//   MAIL_FROM        e.g.  Abacus Labs <hello@yourdomain.com>  (domain verified in Resend)
//   SITE_URL         e.g.  https://my-project-iota-navy.vercel.app  (no trailing slash)
//   DAILY_LIMIT      optional: live-data requests per user per day (default 50)
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LINK_MINUTES = 30;
const SESSION_DAYS = 30;
const SIGNUPS_PER_IP_PER_DAY = 20;
const EMAILS_PER_ADDRESS_PER_DAY = 5;

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

// purpose is 'confirm' (emailed link) or 'session' (signed-in visitor)
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

// One-way hash, so IP addresses and emails are never kept in readable form in the usage table.
const shortHash = (v) => crypto.createHash('sha256').update(v + secret()).digest('hex').slice(0, 32);
function ipHash(req) {
  const ip =
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown';
  return shortHash(ip);
}

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

/* ---------- email ---------- */
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendMail(to, name, link) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) throw new Error('RESEND_API_KEY or MAIL_FROM is not set');
  const text =
    'Hi ' + name + ',\n\n' +
    'Confirm your email to start using the Abacus Labs calculators:\n' + link + '\n\n' +
    'This link works for ' + LINK_MINUTES + " minutes. If you didn't ask for it, you can ignore this email.\n";
  const html =
    '<p>Hi ' + esc(name) + ',</p>' +
    '<p><a href="' + link + '">Confirm your email</a> to start using the Abacus Labs calculators.</p>' +
    '<p>This link works for ' + LINK_MINUTES + ' minutes. If you didn\u2019t ask for it, you can ignore this email.</p>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: 'Confirm your email for Abacus Labs', html, text })
  });
  if (!r.ok) throw new Error('Resend replied ' + r.status);
}

/* ---------- action: signup ---------- */
async function signup(b, req, res) {
  // Hidden field that real people never fill in; simple bots do.
  if (b.website) return res.status(400).json({ error: 'invalid' });

  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  if (name.length < 2 || !EMAIL.test(email)) return res.status(400).json({ error: 'invalid' });
  if (b.consent !== true) return res.status(400).json({ error: 'consent' });

  if (!(await hit('ip:' + ipHash(req), SIGNUPS_PER_IP_PER_DAY))) {
    return res.status(429).json({ error: 'too_many' });
  }
  // Stops the form being used to flood one person's inbox.
  if (!(await hit('mail:' + shortHash(email), EMAILS_PER_ADDRESS_PER_DAY))) {
    return res.status(429).json({ error: 'mail_limit' });
  }

  const dataUse = b.dataUse === true;
  const s = await db();

  // Tidy up: remove sign-ups that were never confirmed within 7 days.
  await s`delete from users where verified_at is null and created_at < now() - interval '7 days'`;

  // Create the user if new. An existing user's name and choices are NOT changed here;
  // they are applied only when the emailed link is opened.
  const rows = await s`
    insert into users (name, email) values (${name}, ${email})
    on conflict (email) do update set email = excluded.email
    returning id`;

  const token = sign({
    p: 'confirm',
    uid: rows[0].id,
    name,
    dataUse,
    exp: Date.now() + LINK_MINUTES * 60000
  });
  const base = (process.env.SITE_URL || 'https://' + req.headers.host).replace(/\/+$/, '');
  try {
    await sendMail(email, name, base + '/?verify=' + encodeURIComponent(token));
  } catch (e) {
    console.error('mail error', e && e.message);
    return res.status(502).json({ error: 'mail_fail' });
  }
  return res.status(200).json({ sent: true });
}

/* ---------- action: confirm ---------- */
async function confirm(b, res) {
  const p = verify(b.t, 'confirm');
  if (!p) return res.status(400).json({ error: 'invalid_link' });

  const dataUse = p.dataUse === true;
  const s = await db();
  const rows = await s`
    update users set
      name = ${p.name},
      verified_at = coalesce(verified_at, now()),
      last_seen_at = now(),
      consent_data_use_at = case
        when ${dataUse}::boolean <> consent_data_use then now()
        else consent_data_use_at end,
      consent_data_use = ${dataUse}::boolean
    where id = ${p.uid}
    returning id, consent_data_use`;
  if (!rows.length) return res.status(400).json({ error: 'invalid_link' });

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
    if (b.action === 'confirm') return await confirm(b, res);
    return await signup(b, req, res);
  } catch (e) {
    console.error('gate error', e && e.message);
    return res.status(500).json({ error: 'server' });
  }
}

module.exports = handler;
module.exports.requireUser = requireUser;
