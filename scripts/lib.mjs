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

// Parse Spanish-formatted numbers: "12.500 €", "5.900", "25.000 km", "1.234,56"
export function parseEsNumber(str) {
  if (str == null) return null;
  if (typeof str === "number" && isFinite(str)) return Math.round(str);
  let s = String(str).trim();
  s = s.replace(/[\s\u00a0\u202f.]/g, (m, i) => (m === "." ? "" : ""));
  // handle thousands dots removed above; now handle decimal comma
  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(",", "."));
  if (!isFinite(n)) return null;
  return Math.round(n);
}

export function extractPrice(text) {
  if (!text) return null;
  // prefer explicit price with currency
  const eur = text.match(/(\d[\d\s\u00a0\u202f.]{0,9})(?:,\d{2})?\s*(?:€|eur\b|euros?\b)/i);
  if (eur) {
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
  const re = /(\d[\d\s\u00a0\u202f.]{0,9})\s*kms?\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    if (/menos de|a los|cambiad|aceite|correas?|kit|cadena|neum|frenos?|bater/.test(before)) continue;
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
  "Moto Guzzi","Piaggio","Vespa","Benelli","CFMoto","Voge","QJ Motor","Royal Enfield",
  "Husqvarna","GasGas","MV Agusta","Norton","Brixton","Fantic","Rieju","Derbi",
  "Malaguti","Peugeot","SYM","Kymco","Zontes","Keeway","Bultaco","Niu","Mash",
  "Zero","Energica","Verge","Can-Am","Indian","Harley-Davidson","Harley","Springfield",
];

export function extractBrand(text) {
  if (!text) return null;
  let best = null;
  for (const b of BRANDS) {
    const idx = text.toLowerCase().indexOf(b.toLowerCase());
    if (idx >= 0 && (best == null || idx < best.idx)) best = { brand: b, idx };
  }
  return best ? best.brand : null;
}

export function detectType(text) {
  if (!text) return "other";
  const t = text.toLowerCase();
  const map = [
    ["scooter|matricul|moto de rueda|maxiscooter|xmax|tmax|forza|sh 3|pcx|nmax|vespa|beverly|burgerman|joymax", "scooter"],
    ["trail|adventure|rally|ténéré|tenere|transalp|v-strom|vstrom|multistrada|gs 8|gs 3|adv|x-adv|cb500x|nx500|himalayan", "trail"],
    ["custom|chopper|bobber|cruiser|rebel|vulcan|iron|softail|street bob|v7|inazuma", "custom"],
    ["sport|superbike|sbk|r6|r1|cbr|gsx-r|gsxr|ninja zx|zx-6|zx-10|panigale|rs 6|rs6|daytona|rr|gp", "sport"],
    ["classic|clásica|café racer|caferacer|scrambler|vintage|retro|xsr|rebel|interceptor|continental|bonneville", "classic"],
    ["touring|viaje|tracer|nt|gt|fjr|klt|sport touring", "touring"],
    ["naked|roadster|mt-0|mt 0|z65|z90|monster|duke|trident|hornet|sv65|street triple|voge 5|tnt|cb65", "naked"],
    ["enduro|motocross|cross|sm|supermotard|exc|sx-f|wr|crf", "enduro"],
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
