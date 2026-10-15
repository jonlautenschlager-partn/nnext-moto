// doctor — diagnostic & regression gate for NNext Moto.
// Verifies data integrity, per-listing quality, A2 coherence, KB health,
// app/dashboard freshness, and CANARY values for every bug class already
// fixed (they must never regress). Run before every commit.
//
//   node scripts/doctor.js          # report; exit 1 on any FAIL
//   node scripts/doctor.js --quiet  # only show FAIL/WARN lines
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, DATA_DIR, readListings, canonicalBrand, titleFromUrlSlug } from "./lib.mjs";
import { a2Check, matchModel } from "./a2.mjs";

const quiet = process.argv.includes("--quiet");
const results = [];
const fail = (id, msg) => results.push(["FAIL", id, msg]);
const warn = (id, msg) => results.push(["WARN", id, msg]);
const pass = (id, msg) => { if (!quiet) results.push(["PASS", id, msg]); };

const JUNK_TITLE = /(^version\b|\bhtm\b|^ubicaci[oó]n:|^localidad:)/i;
const PROV = ["Madrid","Barcelona","Valencia","Sevilla","Zaragoza","Málaga","Murcia","Bilbao","Alicante","Córdoba","Valladolid","Vigo","Gijón","Granada","Segovia","Toledo","Salamanca","Burgos","León","Lleida","Tarragona","Girona","Cádiz","Huelva","Jaén","Almería","Badajoz","Cáceres","Palma","Sant Joan les Fonts"];

async function fileMtime(p) {
  try { return (await stat(p)).mtimeMs; } catch { return 0; }
}

async function main() {
  // ---- 1. data integrity ----
  let listings;
  try {
    listings = await readListings(join(DATA_DIR, "listings.json"));
    pass("integrity", `listings.json parses (${listings.length} listings)`);
  } catch (e) {
    fail("integrity", `listings.json unreadable: ${e.message}`);
    report();
    return;
  }
  const ids = listings.map((l) => l.id);
  if (new Set(ids).size !== ids.length) fail("integrity", "duplicate listing ids");
  for (const l of listings) {
    for (const k of ["id", "url", "site", "scrapeStatus"]) {
      if (l[k] == null || l[k] === "") fail(l.id?.slice(0, 8), `missing ${k}`);
    }
  }

  // ---- 2. links.txt orphans ----
  let links = [];
  try {
    links = (await readFile(join(ROOT, "links.txt"), "utf8")).split("\n").map((s) => s.trim()).filter(Boolean).filter((l) => !l.startsWith("#"));
  } catch {}
  const known = new Set(listings.map((l) => l.url));
  for (const link of links) {
    if (!known.has(link)) warn("links", `link in links.txt not in listings: ${link}`);
  }

  // ---- 3. per-listing quality ----
  for (const l of listings) {
    const sid = l.id?.slice(0, 8) ?? "?";
    const okish = l.scrapeStatus === "ok" || l.scrapeStatus === "ok-pasted-text";
    if (JUNK_TITLE.test(l.title || "")) fail(sid, `junk title: "${l.title}" (parser regression)`);
    if (JUNK_TITLE.test(l.model || "")) fail(sid, `junk model: "${l.model}"`);
    if (okish && !l.brand) fail(sid, `status ${l.scrapeStatus} but no brand`);
    if (okish && !l.model) warn(sid, `status ${l.scrapeStatus} but no model`);
    if (okish && l.price == null) warn(sid, `no price — fill via dashboard edit or paste`);
    if (okish && l.km == null) warn(sid, `no km — fill via dashboard edit or paste`);
    if (l.km != null && (l.km < 100 && l.km !== 0)) fail(sid, `implausible km: ${l.km}`);
    if (l.km != null && l.km > 300000) fail(sid, `implausible km: ${l.km}`);
    if (l.year != null && (l.year < 1980 || l.year > new Date().getFullYear() + 1)) fail(sid, `implausible year: ${l.year}`);
    if (l.price != null && (l.price < 100 || l.price > 100000)) warn(sid, `implausible price: ${l.price}`);
    if (l.powerKw != null && (l.powerKw < 1 || l.powerKw > 150)) fail(sid, `implausible powerKw: ${l.powerKw}`);
    // numeric fields must be real numbers — string "346" (from a mangled edit)
    // passes NaN-ish comparisons and breaks the A2 math silently
    for (const k of ["km", "price", "year", "cc", "powerKw", "powerCv"]) {
      if (l[k] != null && typeof l[k] !== "number") fail(sid, `${k} stored as ${typeof l[k]} ("${l[k]}") — must be a number`);
    }
    if (l.type && !["naked","sport","classic","custom","trail","touring","scooter","enduro","other"].includes(l.type)) fail(sid, `unknown type: ${l.type}`);
    const imgCount = (l.images || []).length + (l.localImages || []).length;
    if (okish && l.site !== "motos.coches.net" && imgCount === 0) warn(sid, `no images archived`);
    if (l.location && !PROV.includes(l.location) && !/^[A-ZÁÉÍÓÚÑ][\wá-úñ\s'-]+$/.test(l.location)) warn(sid, `odd location: ${l.location}`);
    if ((l.notes || []).some((n) => /Version|challenge page returned 200/.test(n)) && okish && l.scrapeStatus === "ok") {
      warn(sid, `stale blocked-note on ok listing: ${l.notes.find((n) => /challenge|Version/.test(n))}`);
    }
    // description must not carry section headers leaked from old parser bugs
    if (l.description && /^(Descripción|Características)\b/.test(l.description.trim())) fail(sid, `description starts with a leaked header`);
  }

  // ---- 4. A2 coherence: recompute and compare ----
  for (const l of listings) {
    if (!l.a2) continue;
    const fresh = await a2Check(l);
    if (fresh.legal !== l.a2.legal || fresh.restricted !== l.a2.restricted) {
      fail(l.id.slice(0, 8), `A2 stale: stored legal=${l.a2.legal}/r=${l.a2.restricted} vs recomputed legal=${fresh.legal}/r=${fresh.restricted} — run reenrich`);
    }
  }

  // ---- 5. KB health ----
  let kb;
  try {
    kb = JSON.parse(await readFile(join(ROOT, "knowledge-base", "models.json"), "utf8")).models || [];
    pass("kb", `${kb.length} models`);
  } catch (e) {
    fail("kb", `models.json unreadable: ${e.message}`);
  }
  const seen = new Set();
  for (const m of kb) {
    const key = `${m.make}|${m.name}`.toLowerCase();
    if (seen.has(key)) fail("kb", `duplicate model ${m.make} ${m.name}`);
    seen.add(key);
    if (m.stockKw == null || m.stockKw <= 0) fail("kb", `${m.make} ${m.name}: bad stockKw`);
    if (m.cc == null || m.cc < 40) fail("kb", `${m.make} ${m.name}: bad cc`);
  }

  // ---- 6. canary regressions (each maps to a bug class already fixed) ----
  const canaries = [
    ["e85828e0", "MT-07 power must stay 70 (limitada false-positive)", (l) => l.powerKw === 70 && l.a2?.legal === false],
    ["6ddf8d30", "SV650 '(No Limitada)' must not cap power at 35", (l) => l.powerKw === 56 && l.a2?.legal === false],
    ["f1b21ac6", "Monster 797 km must be 19800 (comma thousands)", (l) => l.km === 19800],
    ["cbd086a5", "Monster 696 model must be canonical (not 'Monster')", (l) => l.model === "Monster 696"],
    ["c6bfdd12", "cuimo ad must be Honda CBR500R @5199 (not brand=Cuimo)", (l) => l.brand === "Honda" && l.model === "CBR500R" && l.price === 5199],
    ["d36ab1aa", "XSR700 must stay A2-legal-restricted", (l) => l.a2?.legal === true && l.a2?.restricted === true],
    ["0d06d2a5", "cochesnet year from URL slug (2017)", (l) => l.year === 2017 && l.brand === "Honda"],
    ["0d58ab01", "repair-quote price ('presupuestado en 500€') must not be sale price", (l) => l.price !== 500],
    ["8725fb7b", "moto-ocasion CBR500R: real price 5250 (WooCommerce price, not related card) + kw 34.6 (not mangled 346)", (l) => l.price === 5250 && l.powerKw === 34.6],
  ];
  for (const [prefix, what, check] of canaries) {
    const l = listings.find((x) => x.id?.startsWith(prefix));
    if (!l) { warn("canary", `${what}: listing ${prefix} not found`); continue; }
    if (check(l)) pass("canary", what);
    else fail(l.id.slice(0, 8), `canary failed: ${what} (got kw=${l.powerKw} km=${l.km} model=${l.model} brand=${l.brand} a2=${l.a2?.legal}/${l.a2?.restricted} price=${l.price})`);
  }

  // ---- 7. paste/parser parity (catches parser regressions against stored data) ----
  const PASTE_FIELDS = ["title","brand","model","type","year","km","price","cc","powerCv","powerKw","location"];
  for (const l of listings) {
    const pastePath = join(ROOT, "inbox", `${l.id}.txt`);
    let text;
    try { text = await readFile(pastePath, "utf8"); } catch { continue; }
    let parsed;
    try { parsed = (await import("./parse-text.mjs")).parseAdText(text); } catch (e) { fail(l.id.slice(0, 8), `parseAdText crashed: ${e.message}`); continue; }
    const manual = new Set(l.manualFields || []);
    for (const k of PASTE_FIELDS) {
      if (!manual.has(k)) continue;
      if (parsed[k] == null || parsed[k] === "") continue;
      if (String(l[k] ?? "") !== String(parsed[k])) {
        warn(l.id.slice(0, 8), `paste parity drift on ${k}: stored "${l[k]}" vs parsed "${parsed[k]}"`);
      }
    }
  }

  // ---- 8. dashboard freshness ----
  const dataJsMtime = await fileMtime(join(ROOT, "app", "data.js"));
  const listingsMtime = await fileMtime(join(DATA_DIR, "listings.json"));
  if (listingsMtime > dataJsMtime + 2000) warn("app", "app/data.js older than listings.json — run npm run build");

  // ---- report ----
  report();
}

function report() {
  const errors = results.filter(([s]) => s === "FAIL");
  const warns = results.filter(([s]) => s === "WARN");
  for (const [s, id, msg] of results) console.log(`${s.padEnd(5)} [${id}] ${msg}`);
  console.log(`\ndoctor: ${errors.length} fail(s), ${warns.length} warn(s)`);
  if (errors.length) process.exit(1);
}

main().catch((e) => { console.error("doctor crashed:", e); process.exit(1); });
