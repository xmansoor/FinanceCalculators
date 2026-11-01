// Vercel serverless function: GET /api/riskfree
// Returns the latest US Treasury and UK gilt par yields as JSON.
// Sources (free, no key): US Treasury daily par yield curve XML feed; Bank of England Statistical Database CSV.

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; WACC-calculator)' };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const US_TAGS = { 5: 'BC_5YEAR', 7: 'BC_7YEAR', 10: 'BC_10YEAR', 20: 'BC_20YEAR', 30: 'BC_30YEAR' };
const UK_CODES = { 5: 'IUDSNPY', 10: 'IUDMNPY', 20: 'IUDLNPY' };

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ---------- US ----------
function parseTreasury(xml) {
  let best = null;
  for (const e of xml.split('<entry>').slice(1)) {
    const dm = /<d:NEW_DATE[^>]*>([^<]+)</.exec(e);
    if (!dm) continue;
    const date = dm[1].slice(0, 10);
    const rates = {};
    for (const [y, tag] of Object.entries(US_TAGS)) {
      const m = new RegExp('<d:' + tag + '[^>]*>([^<]*)</d:' + tag + '>').exec(e);
      const v = m ? parseFloat(m[1]) : NaN;
      if (isFinite(v)) rates[y] = v;
    }
    if (rates[10] !== undefined && (!best || date > best.date)) best = { date, rates };
  }
  return best;
}
async function getUS() {
  const now = new Date();
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const ym = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0');
    const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=' + ym;
    const best = parseTreasury(await get(url));
    if (best) return {
      asOf: best.date, rates: best.rates,
      source: 'US Treasury, Daily Treasury Par Yield Curve Rates',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve'
    };
  }
  throw new Error('No US Treasury data found');
}

// ---------- UK ----------
function boeDate(s) {
  s = s.replace(/"/g, '').trim();
  let m = /^(\d{1,2})[ \/-]([A-Za-z]{3})[A-Za-z]*[ \/-](\d{4})$/.exec(s);
  if (m) {
    const mi = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
    if (mi >= 0) return m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function parseBoE(csv) {
  let best = null;
  for (const line of csv.trim().split(/\r?\n/)) {
    const c = line.split(',');
    const v = parseFloat((c[1] || '').replace(/"/g, ''));
    const d = boeDate(c[0] || '');
    if (isFinite(v) && d && (!best || d > best.date)) best = { date: d, value: v };
  }
  return best;
}
const boeFmt = d => String(d.getUTCDate()).padStart(2, '0') + '/' + MON[d.getUTCMonth()] + '/' + d.getUTCFullYear();
async function getUK() {
  const to = new Date(), from = new Date(Date.now() - 25 * 864e5);
  const rates = {}; let asOf = null;
  await Promise.all(Object.entries(UK_CODES).map(async ([y, code]) => {
    try {
      const url = 'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&SeriesCodes=' + code + '&UsingCodes=Y&CSVF=TN&Datefrom=' + boeFmt(from) + '&Dateto=' + boeFmt(to);
      const b = parseBoE(await get(url));
      if (b) { rates[y] = b.value; if (y === '10' || !asOf) asOf = b.date; }
    } catch (e) { /* skip this maturity */ }
  }));
  if (!Object.keys(rates).length) throw new Error('No Bank of England data found');
  return {
    asOf, rates,
    source: 'Bank of England, nominal par gilt yield (Statistical Database)',
    url: 'https://www.bankofengland.co.uk/boeapps/database/'
  };
}

module.exports = async (req, res) => {
  const [us, uk] = await Promise.allSettled([getUS(), getUK()]);
  const out = { us: null, uk: null, errors: {} };
  if (us.status === 'fulfilled') out.us = us.value; else out.errors.us = String(us.reason && us.reason.message || us.reason);
  if (uk.status === 'fulfilled') out.uk = uk.value; else out.errors.uk = String(uk.reason && uk.reason.message || uk.reason);
  if (!out.us && !out.uk) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json(out); }
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json(out);
};
module.exports.parseTreasury = parseTreasury;
module.exports.parseBoE = parseBoE;

