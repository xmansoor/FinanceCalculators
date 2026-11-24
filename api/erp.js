// Vercel serverless function: GET /api/erp
// Returns Damodaran's latest monthly implied equity risk premium for the US market as JSON.
// Source (free, no key): the Damodaran Online home page, which states the implied ERP for the current month,
// with several measures on one line, e.g. "Implied ERP on November 1, 2026 = 4.41% (Trailing 12 month, with adjusted payout); 3.79% (...); ..."
// The first measure listed is used as the headline. The page is updated monthly.

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; WACC-calculator)' };
const PAGE = 'https://pages.stern.nyu.edu/adamodar/New_Home_Page/home.htm';
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function parseERP(html) {
  const text = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const m = /Implied ERP on\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s*=\s*/i.exec(text);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  const asOf = m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + m[2].padStart(2, '0');

  const rest = text.slice(m.index + m[0].length);
  const cut = rest.search(/\(with the US|Day-to-day|Implied ERP in previous/i);
  const block = cut >= 0 ? rest.slice(0, cut) : rest.slice(0, 400);

  const measures = [];
  const re = /(\d+(?:\.\d+)?)\s*%\s*\(([^)]+)\)/g;
  let x;
  while ((x = re.exec(block))) measures.push({ value: parseFloat(x[1]), label: x[2].trim() });
  if (!measures.length) {
    const s = /(\d+(?:\.\d+)?)\s*%/.exec(block);
    if (s) measures.push({ value: parseFloat(s[1]), label: 'Implied ERP' });
  }
  const good = measures.filter(v => isFinite(v.value) && v.value > 0 && v.value < 20);
  if (!good.length) return null;

  const tr = /treasury rate of\s+(\d+(?:\.\d+)?)\s*%/i.exec(rest);
  return { asOf, headline: good[0], measures: good, rfUsed: tr ? parseFloat(tr[1]) : null };
}

module.exports = async (req, res) => {
  try {
    const p = parseERP(await get(PAGE));
    if (!p) throw new Error('Could not find the implied ERP on the Damodaran home page. The page layout may have changed.');
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({
      asOf: p.asOf,
      headline: p.headline,
      measures: p.measures,
      rfUsed: p.rfUsed,
      source: 'Damodaran Online, implied equity risk premium for the US market',
      url: PAGE
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
module.exports.parseERP = parseERP;
