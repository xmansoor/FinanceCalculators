// Vercel serverless function: GET /api/betas?region=us|global
// Returns Damodaran's industry betas as JSON: levered beta, D/E, tax, unlevered beta, cash-corrected unlevered beta.
// Source (free, no key): the "Betas by Sector" tables on Damodaran Online, updated once a year (January).
// To add a region later, add its table page to REGIONS below.

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; WACC-calculator)' };
const BASE = 'https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/';
const REGIONS = {
  us: { file: 'Betas.html', label: 'US' },
  global: { file: 'BetasGlobal.html', label: 'Global' }
};

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const clean = s => String(s)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ')
  .trim();
const numOf = s => {
  const v = parseFloat(String(s).replace(/[%,\s]/g, ''));
  return isFinite(v) ? v : NaN;
};
const median = a => {
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};

function parseBetas(html) {
  const rows = (String(html).match(/<tr[\s\S]*?<\/tr>/gi) || []).map(r =>
    (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(clean));

  // Find the header row and map the columns by name, so a shifted layout does not break the reading.
  let col = null, start = -1;
  for (let i = 0; i < rows.length && !col; i++) {
    const h = rows[i].map(x => x.toLowerCase());
    const at = f => h.findIndex(f);
    const c = {
      name: at(x => x === 'industry name'),
      n: at(x => x === 'number of firms'),
      beta: at(x => x === 'beta'),
      de: at(x => x.startsWith('d/e')),
      etr: at(x => x.startsWith('effective tax')),
      unlev: at(x => x === 'unlevered beta'),
      cash: at(x => x.startsWith('cash/firm')),
      unlevCash: at(x => x.startsWith('unlevered beta corrected'))
    };
    if (c.name >= 0 && c.beta >= 0 && c.de >= 0 && c.unlev >= 0 && c.unlevCash >= 0) { col = c; start = i + 1; }
  }
  if (!col) return null;

  const industries = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i], name = r[col.name];
    if (!name) continue;
    const o = {
      name,
      n: numOf(r[col.n]),
      beta: numOf(r[col.beta]),
      de: numOf(r[col.de]),
      etr: numOf(r[col.etr]),
      unlev: numOf(r[col.unlev]),
      cash: numOf(r[col.cash]),
      unlevCash: numOf(r[col.unlevCash])
    };
    if ([o.beta, o.de, o.unlev, o.unlevCash].every(isFinite) && o.beta > 0 && o.beta < 6 && o.unlev > 0 && o.unlevCash > 0 && o.de >= 0) {
      industries.push(o);
    }
  }
  if (industries.length < 20) return null;

  // The unlevered betas on the page use a marginal tax rate, not the effective-rate column.
  const text = clean(html);
  let marginalTax = null, taxBasis = 'page';
  const m = /marginal tax rate to use[^0-9]{0,40}([\d.]+)\s*%/i.exec(text);
  if (m && isFinite(parseFloat(m[1]))) marginalTax = parseFloat(m[1]);
  if (marginalTax === null) {
    // Not stated: back it out from the published figures (beta, D/E and unlevered beta) and take the median.
    const t = industries.filter(o => o.de > 5).map(o => 100 * (1 - (o.beta / o.unlev - 1) / (o.de / 100))).filter(v => v > 0 && v < 60);
    marginalTax = t.length ? Math.round(median(t) * 100) / 100 : null;
    taxBasis = 'implied';
  }
  const d = /as of\s+([A-Za-z]+\s+\d{4})/i.exec(text);
  return { industries, marginalTax, taxBasis, asOf: d ? d[1] : null };
}

module.exports = async (req, res) => {
  const key = String((req.query && req.query.region) || 'us').toLowerCase();
  const reg = REGIONS[key];
  if (!reg) return res.status(400).json({ error: 'Unknown region. Use one of: ' + Object.keys(REGIONS).join(', ') });
  try {
    const url = BASE + reg.file;
    const p = parseBetas(await get(url));
    if (!p) throw new Error('Could not read the industry table on the Damodaran page. The layout may have changed.');
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      region: key,
      label: reg.label,
      asOf: p.asOf || 'date not stated',
      marginalTax: p.marginalTax,
      taxBasis: p.taxBasis,
      source: 'Damodaran Online, Betas by Sector (' + reg.label + ')',
      url,
      industries: p.industries
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
module.exports.parseBetas = parseBetas;
