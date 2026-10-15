// mundimoto.com extractor (Next.js RSC dealer site, fully server-rendered and
// scrapable). Data lives in an escaped-JSON blob: \"kms\":46289, \"year\":2009,
// \"cc\":696, \"kw\":55, \"offer_price\":{\"value\":3499,...} plus a gallery of
// brandedimages.mundimoto.com URLs (medium size is the only reliably-served one).
export const host = "mundimoto.com";

function escJsonNum(html, key) {
  // matches both escaped (\"kms\":46289) and plain ("kms":46289) forms
  const m = html.match(new RegExp(`\\\\"?${key}\\\\?":\\\\?"?([0-9]{1,6}(?:[.,][0-9]+)?)`, "i"));
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function parse({ html, url, data }) {
  const out = {};

  const km = escJsonNum(html, "kms") ?? escJsonNum(html, "mileage");
  if (km != null && km >= 0 && km <= 300000) out.km = Math.round(km);

  const year = escJsonNum(html, "year");
  if (year && year >= 1980 && year <= new Date().getFullYear() + 1) out.year = year;

  const cc = escJsonNum(html, "cc");
  if (cc && cc >= 40 && cc <= 2500) out.cc = cc;

  const kw = escJsonNum(html, "kw");
  if (kw && kw > 1 && kw <= 150) out.powerKw = kw;

  // cash price (exact key "price"), never finance_price/offer_price — the
  // financed figure is an interest-aided promo, not what the bike costs
  const price = (html.match(/[^_a-z]\\?"price\\?":\{\\?"value\\?":\\?"?(\d+)/) || [])[1];
  if (price && +price > 300 && +price <= 100000) out.price = +price;

  const ogTitle = (html.match(/property="og:title" content="([^"]+)"/) || [])[1];
  if (ogTitle) out.title = ogTitle.replace(/\s*[-|]\s*mundimoto.*$/i, "").trim();

  // gallery: dedupe by angle, prefer the medium size (large is not always served)
  const found = [];
  const seen = new Set();
  const re = /https:\/\/brandedimages\.mundimoto\.com\/[^"'\s\\]+\.(?:jpe?g|png|webp)/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[0].replace(/\\/g, "");
    u = u.replace(/-(small|medium|large)\./, "-medium.");
    if (seen.has(u)) continue;
    seen.add(u);
    found.push(u);
  }
  if (found.length) out.images = found.slice(0, 20);

  // availability: PUBLISHED = on sale; SOLD marks it sold
  if (/"status\\?":\\?"SOLD/i.test(html)) out.availability = "sold";
  else if (/"status\\?":\\?"PUBLISHED/i.test(html)) out.availability = "available";

  const desc = (html.match(/property="og:description" content="([^"]+)"/) || [])[1];
  if (desc) out.description = desc.trim();

  return out;
}
