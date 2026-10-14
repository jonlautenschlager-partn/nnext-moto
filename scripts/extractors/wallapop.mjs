// Wallapop extractor.
// Item pages are Next.js apps embedding full product data in __NEXT_DATA__.
// CI runners get 403 (datacenter IP); residential IPs (the user's Mac) get 200.
function decode(json) {
  return json;
}

function parseCharacteristics(s) {
  // "2019 · 48000 km · Rojo"
  if (!s) return {};
  const out = {};
  const parts = String(s).split("·").map((x) => x.trim());
  const yearM = String(s).match(/\b(19[89]\d|20[0-3]\d)\b/);
  if (yearM) out.year = parseInt(yearM[1], 10);
  const kmM = String(s).match(/([\d.,]+)\s*km/i);
  if (kmM) {
    const n = parseFloat(kmM[1].replace(/\./g, "").replace(",", "."));
    if (isFinite(n)) out.km = Math.round(n);
  }
  if (parts.length >= 3) out.color = parts[2];
  return out;
}

export const host = "wallapop.com";

export function parse({ html, url, data }) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const pp = j?.props?.pageProps || {};
  const item = pp.item;
  if (!item) return { scrapeStatus: "blocked", notes: ["Wallapop page loaded without item payload (possible challenge)"] };

  const out = {};
  const title = item.title?.original;
  if (title) out.title = title;
  const price = item.price?.cash?.amount;
  if (price != null) {
    out.price = price;
    out.currency = item.price?.cash?.currency || "EUR";
  }
  Object.assign(out, parseCharacteristics(item.characteristics));
  if (item.brand) out.brand = item.brand;
  if (item.model) out.model = item.model;
  const loc = item.location;
  if (loc?.city) out.location = loc.city;
  if (loc?.postalCode) out.postalCode = loc.postalCode;
  if (item.description?.original) out.description = item.description.original.slice(0, 600);
  const imgs = (item.images || []).map((im) => im.urls?.big || im.urls?.medium).filter(Boolean);
  if (imgs.length) out.images = imgs.slice(0, 8);
  if (item.modifiedDate) out.lastModified = new Date(item.modifiedDate).toISOString();
  const seller = pp.itemSeller || {};
  out.seller = seller.type && /normal|particular/i.test(seller.type) ? "particular" : seller.type ? "professional" : null;
  if (seller.extraInfoPro) out.seller = "professional";

  // reserved/sold signals
  const flags = item.flags || {};
  if (flags.reserved || item.reserved) out.status = "active";
  return out;
}
