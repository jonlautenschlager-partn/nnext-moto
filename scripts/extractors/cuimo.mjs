// cuimo.com — dealer site (Next.js). Server-rendered JSON-LD plus a Criteo-style
// hidden block (".cn_product_visited") that carries the real moto data. The
// JSON-LD "brand" is the shop itself (Cuimo), never the bike maker.
import { cleanText, parseEsNumber, canonicalBrand } from "../lib.mjs";

export const host = "cuimo.com";

const TYPE_MAP = {
  sport: "sport", trail: "trail", adventure: "trail", scooter: "scooter",
  custom: "custom", naked: "naked", touring: "touring", classic: "classic",
  enduro: "enduro", motard: "enduro", cross: "enduro",
};

export async function parse({ html, url, data }) {
  const out = {};

  // Criteo-style hidden block with clean per-field values
  const block = html.match(/<div class="cn_product_visited"[\s\S]*?<\/div>/i)?.[0] || "";
  const span = (cls) => {
    const m = block.match(new RegExp(`<span class="${cls}">([\\s\\S]*?)</span>`, "i"));
    return m ? cleanText(m[1]) : null;
  };
  const name = span("name");
  const brand = span("brand");
  const unitPrice = span("unit_price");
  const category = span("category");
  const tags = [...block.matchAll(/<span class="tag">([^<]+)<\/span>/gi)].map((m) => m[1]);

  if (brand && !/^cuimo\b/i.test(brand)) out.brand = canonicalBrand(brand);
  if (name) out.model = name.replace(/\s+/g, " ").trim();
  if (unitPrice) {
    const p = parseEsNumber(unitPrice);
    if (p && p >= 100) out.price = p;
  }
  for (const tag of tags) {
    const cc = tag.match(/^cc_([\d.]+)$/i);
    const yr = tag.match(/^year_(\d{4})$/i);
    const km = tag.match(/^km_([\d.]+)$/i);
    if (cc) out.cc = parseInt(parseEsNumber(cc[1]), 10);
    else if (yr) out.year = parseInt(yr[1], 10);
    else if (km) out.km = parseEsNumber(km[1]);
  }
  if (category) {
    const t = TYPE_MAP[category.toLowerCase()];
    if (t) out.type = t;
  }

  // every photo referenced anywhere in the page (og:image, preloads, RSC payload)
  const seen = new Set();
  const imgs = [];
  const push = (u) => {
    if (!u) return;
    const base = String(u).split("?")[0];
    if (!/images\.cuimo\.com\/[^/]+\.(?:jpe?g|png|webp)$/i.test(base) || seen.has(base)) return;
    seen.add(base);
    imgs.push(`${base}?width=1600&quality=90`);
  };
  push(data.images?.[0]);
  for (const m of html.matchAll(/images\.cuimo\.com\/[^"'\\?\s]+?\.(?:jpe?g|png|webp)/gi)) push(m[0]);
  if (imgs.length) out.images = imgs.slice(0, 10);

  // og:title carries the shop suffix: "HONDA CBR 500 R 2021 5199€ - Cuimo"
  if (data.title) {
    const t = data.title.replace(/\s*[-–—|]\s*Cuimo\s*$/i, "").trim();
    if (t) out.title = t;
  }

  return out;
}
