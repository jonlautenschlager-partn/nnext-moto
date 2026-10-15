import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = join(ROOT, "data");
export const KB_DIR = join(ROOT, "knowledge-base");

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// listings.json is precious: on parse failure, fail loudly instead of silently
// returning a fallback (which would forget every listing and destroy history)
export async function readListings(path) {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.listings || [];
  } catch (e) {
    throw new Error(`listings.json is not valid JSON (${e.message}) — refusing to run to avoid data loss; restore the file first`);
  }
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

export function listingId(url) {
  return createHash("sha1")
    .update(url.replace(/[?#].*$/, ""))
    .digest("hex")
    .slice(0, 12);
}

export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

// Parse Spanish-formatted numbers: "12.500 €", "5.900", "25.000 km", "1.234,56".
// English-style thousands also handled: "19,800 km" -> 19800.
export function parseEsNumber(str) {
  if (str == null) return null;
  if (typeof str === "number" && isFinite(str)) return Math.round(str);
  let s = String(str).trim().replace(/[\s\u00a0\u202f]/g, "");
  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  let num = m[0];
  const hasDot = num.includes("."), hasComma = num.includes(",");
  if (hasDot && hasComma) {
    // Spanish format: dots = thousands, comma = decimals
    num = num.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    // comma followed by exactly 3 digits at the end = thousands separator
    if (/,\d{3}$/.test(num)) num = num.replace(/,/g, "");
    else num = num.replace(",", ".");
  } else if (hasDot) {
    // bare dots = thousands separators (Spanish convention)
    num = num.replace(/\./g, "");
  }
  const n = parseFloat(num);
  if (!isFinite(n)) return null;
  return Math.round(n);
}

export function extractPrice(text) {
  if (!text) return null;
  // prefer explicit price with currency; skip repair-cost mentions
  // ("presupuestado en 500 euros" is a quote, not the sale price)
  const eurRe = /(\d[\d\s\u00a0\u202f.]{0,9})(?:,\d{2})?\s*(?:€|eur\b|euros?\b)/gi;
  let eur;
  while ((eur = eurRe.exec(text))) {
    const before = text.slice(Math.max(0, eur.index - 30), eur.index).toLowerCase();
    if (/presupuestad|presupuesto|reparaci[oó]n|coste|cost[óo]|se gast|cambio de/i.test(before)) continue;
    const n = parseEsNumber(eur[1]);
    if (n && n >= 300 && n <= 100000) return n;
  }
  return null;
}

// km of the listing (odometer), not service intervals like "menos de 3.000kms"
export function extractKm(text) {
  if (!text) return null;
  // Wallapop/portal style: a line "Km" (or "Kilómetros") followed by the value
  const labeled = text.match(/(?:^|\n)\s*k[ií]l[oó]metros?\s*\n+\s*([\d.,]+)\s*kms?\b/i)
    || text.match(/(?:^|\n)\s*km\s*\n+\s*([\d.,]+)\s*kms?\b/i);
  if (labeled) {
    const n = parseEsNumber(labeled[1]);
    if (n != null && n >= 0 && n <= 300000) return n;
  }
  const re = /(\d[\d\s\u00a0\u202f.,]{0,9})\s*kms?\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    if (/menos de|mas de|más de|a los|cambiad|aceite|correas?|kit|cadena|neum|frenos?|bater/.test(before)) continue;
    const n = parseEsNumber(m[1]);
    if (n == null) continue;
    // odometer values are either 0 (nueva) or >= 100; ignore round small numbers like 1000 unless labeled
    if (n === 0) return 0;
    if (n >= 100 && n <= 300000) return n;
  }
  return null;
}

export function extractYear(text) {
  if (!text) return null;
  // Wallapop/portal style: "Año" line followed by the year
  const labeled = text.match(/(?:^|\n)\s*a[ñn]o\s*\n+\s*(\d{4})/i);
  if (labeled) {
    const y = parseInt(labeled[1], 10);
    if (y >= 1980 && y <= new Date().getFullYear() + 1) return y;
  }
  const re = /\b(19[89]\d|20[0-3]\d)\b/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
    if (/se hizo|en julio|en junio|conversion|revisad|itv|comprad/.test(before)) continue;
    const y = parseInt(m[1], 10);
    if (y >= 1980 && y <= new Date().getFullYear() + 1) return y;
  }
  return null;
}

export function extractCvKw(text) {
  if (!text) return { cv: null, kw: null };
  const cv = text.match(/(\d{1,3}(?:[.,]\d)?)\s*(?:cv|caballos?)\b/i);
  const kw = text.match(/(\d{1,3}(?:[.,]\d)?)\s*kw\b/i);
  return {
    cv: cv ? parseFloat(cv[1].replace(",", ".")) : null,
    kw: kw ? parseFloat(kw[1].replace(",", ".")) : null,
  };
}

export function extractCc(text) {
  if (!text) return null;
  const m = text.match(/\b(\d{2,4})\s*(?:cc|c\.c\.|cilindrada)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 50 && n <= 2500) return n;
  }
  return null;
}

const BRANDS = [
  "Yamaha","Honda","Kawasaki","Suzuki","KTM","Aprilia","Triumph","BMW","Ducati",
  "Moto Guzzi","Piaggio","Vespa","Benelli","CFMoto","CF Moto","Voge","QJ Motor","Royal Enfield",
  "Husqvarna","GasGas","Gas Gas","MV Agusta","Norton","Brixton","Fantic","Rieju","Derbi",
  "Malaguti","Peugeot","SYM","Kymco","Zontes","Keeway","Bultaco","Niu","Mash",
  "Zero","Energica","Verge","Can-Am","Indian","Harley-Davidson","Harley","Springfield",
  "Mondial","Italjet","SWM","Beta","Sherco","AJP","Ural","Jawa","ORCAL","KSR",
];

const BRAND_RE = new RegExp(
  BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i"
);

export function extractBrand(text) {
  if (!text) return null;
  let best = null;
  for (const m of String(text).matchAll(new RegExp(BRAND_RE.source, "gi"))) {
    // word boundary: avoid matches inside larger words
    const before = m.input[m.index - 1];
    const after = m.input[m.index + m[0].length];
    if (before && /[A-Za-zÀ-ÿ0-9]/.test(before)) continue;
    if (after && /[A-Za-zÀ-ÿ0-9]/.test(after)) continue;
    if (best == null || m.index < best.idx) best = { brand: BRANDS.find((b) => b.toLowerCase() === m[0].toLowerCase()) || m[0], idx: m.index };
  }
  if (!best) return null;
  // normalize aliases to canonical name
  const alias = { "harley": "Harley-Davidson", "gas gas": "GasGas", "cf moto": "CFMoto" };
  const key = best.brand.toLowerCase();
  return alias[key] || best.brand;
}

// dealer-site self-reference: JSON-LD "brand: Cuimo" is the shop, not the bike
export function brandIsSiteSelf(brand, site) {
  if (!brand || !site) return false;
  const b = String(brand).toLowerCase().replace(/[^a-z0-9]/g, "");
  const host = String(site).split(".")[0].replace(/[^a-z0-9]/g, "");
  if (!b || !host) return false;
  return b === host || (host.includes(b) && b.length >= 4);
}

// normalize brand casing/spelling to the canonical list entry ("HONDA" -> "Honda")
export function canonicalBrand(brand) {
  if (!brand) return brand;
  const b = String(brand).trim();
  const hit = BRANDS.find((x) => x.toLowerCase() === b.toLowerCase());
  return hit || b;
}

// pull the model out of a title like "HONDA CBR 500 R de segunda mano" -> "CBR 500 R"
const MODEL_STOP = /^(de|del|con|por|para|en|y|e|o|año|anno|km|kms|cv|kw|cc|abs|segunda|mano|ocasion|ocasión|nueva|nuevo|usada|usado|matriculad\w*|gasolina|diesel|diésel|el[eé]ctric\w*|h[íi]brid\w*|apta?\b|limitad\w*|a2|revisad\w*|garantizad\w*|financiad\w*|barat\w*|precio|rebajad\w*|oferta)/i;

export function extractModelFromTitle(title, brand) {
  if (!title) return null;
  let s = String(title).trim();
  if (brand) {
    const re = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const m = s.match(re);
    if (m) s = s.slice(m.index + m[0].length).trim();
  }
  const tokens = [];
  for (const tok of s.split(/\s+/)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-+./]*$/.test(tok)) break;
    if (MODEL_STOP.test(tok)) break;
    if (tokens.length >= 5) break;
    // a year-like token ends the model name wherever it appears (R 1250 GS keeps "1250")
    if (/^(19|20)\d{2}$/.test(tok)) break;
    if (/^[€$]\d/.test(tok)) break;
    tokens.push(tok);
  }
  const model = tokens.join(" ").trim();
  return model.length >= 2 ? model : null;
}

// ad says the bike IS A2-restricted ("limitada"), but NOT when the text negates
// it ("No Limitada", "sin limitar", "no está limitada")
export function saysRestricted(text) {
  if (!text) return false;
  const re = /limitad\w*|restringid\w*/gi;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 14), m.index);
    if (/\b(?:no|sin|tampoco|jamás)\b\s*(?:est[aá]\s*)?$/i.test(before)) continue;
    return true;
  }
  return false;
}

// derive a title from the URL path slug: ".../ducati-monster-797-roja-2018-1267168307"
// -> "Ducati Monster 797 Roja 2018" (generic fallback when a site blocks scraping)
// Returns null for slugs that carry no usable title (portal "version_" slugs,
// bare ids) — callers then fall back to brand+model or URL-path enrichment.
export function titleFromUrlSlug(url) {
  try {
    const path = new URL(url).pathname;
    const seg = path.split("/").filter(Boolean).pop() || "";
    let s = seg
      .replace(/\.x?html?$/i, "")
      .replace(/[-_]?[0-9a-f]{6,}$/i, "") // trailing id: -1267168307, -797d35ce
      .replace(/[-_]+/g, " ")
      .trim();
    if (!s) return null;
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length < 2) return null;
    // portal-internal slugs ("version_2019____2021-2019-en-valencia") hold no
    // human title — parsing them yields junk like "Version 2019 2021 2019"
    if (/^version\b/i.test(s) || /^\d/.test(words[0])) return null;
    return words
      .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
  } catch {
    return null;
  }
}

export function detectType(text) {
  if (!text) return "other";
  const t = text.toLowerCase();
  const map = [
    ["scooter|matricul|moto de rueda|maxiscooter|xmax|tmax|forza|sh 3|pcx|nmax|vespa|beverly|burgerman|joymax", "scooter"],
    ["trail|adventure|rally|ténéré|tenere|transalp|v-strom|vstrom|multistrada|\\bgs 8\\b|\\bgs 3\\b|\\badv\\b|x-adv|cb500x|nx500|himalayan", "trail"],
    ["custom|chopper|bobber|\\bcruiser\\b|\\brebel\\b|vulcan|\\biron\\b|softail|street bob|\\bv7\\b|inazuma", "custom"],
    ["sport|deportiva|superbike|sbk|\\br6\\b|\\br1\\b|\\bcbr\\b|gsx-r|gsxr|ninja zx|zx-6|zx-10|panigale|\\brs 6\\b|\\brs6\\b|daytona|\\brr\\b|\\bgp\\b", "sport"],
    ["classic|clásica|café racer|caferacer|scrambler|vintage|\\bretro\\b|\\bxsr\\b|interceptor|continental|bonneville", "classic"],
    ["touring|viaje|tracer|\\bnt\\b|\\bgt\\b|fjr|\\bklt\\b|sport touring", "touring"],
    ["naked|roadster|mt-0|mt 0|\\bz65\\b|\\bz90\\b|monster|duke|trident|hornet|\\bsv65\\b|street triple|voge 5|tnt|cb65", "naked"],
    ["enduro|motocross|\\bcross\\b|\\bsm\\b|supermotard|exc|sx-f|\\bwr\\b|crf", "enduro"],
  ];
  for (const [re, type] of map) {
    if (new RegExp(re, "i").test(t)) return type;
  }
  return "other";
}

export function cleanText(s) {
  if (!s) return "";
  return s
    .replace(/\s+/g, " ")
    .replace(/[\u00a0\u202f]/g, " ")
    .trim();
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function diffPrice(oldP, newP) {
  if (oldP == null || newP == null || oldP === newP) return 0;
  return Math.round(((newP - oldP) / oldP) * 100);
}
