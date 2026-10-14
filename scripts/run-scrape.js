import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { extract } from "./scrape.mjs";
import { a2Check, matchModel } from "./a2.mjs";
import { estimateInsurance } from "./insurance.mjs";
import { parseAdText } from "./parse-text.mjs";
import { readListings, writeJson, listingId, DATA_DIR, ROOT, today, nowIso, diffPrice, extractBrand, extractModelFromTitle, brandIsSiteSelf, canonicalBrand, detectType } from "./lib.mjs";

const args = process.argv.slice(2);
const newOnly = args.includes("--new-only");
const quiet = args.includes("--quiet");
const reenrichOnly = args.includes("--reenrich-only");

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function normalize(r) {
  return {
    title: r.title ?? null,
    brand: r.brand ?? null,
    model: r.model ?? null,
    type: r.type ?? "other",
    year: r.year ?? null,
    km: r.km ?? null,
    price: r.price ?? null,
    currency: r.currency ?? "EUR",
    location: r.location ?? null,
    seller: r.seller ?? null,
    powerKw: r.powerKw ?? null,
    powerCv: r.powerCv ?? null,
    cc: r.cc ?? null,
    fuel: r.fuel ?? null,
    gearbox: r.gearbox ?? null,
    color: r.color ?? null,
    carnet: r.carnet ?? null,
    postalCode: r.postalCode ?? null,
    lastModified: r.lastModified ?? null,
    condition: r.condition ?? null,
    productId: r.productId ?? null,
    images: r.images ?? null,
    description: r.description ?? null,
    availability: r.availability ?? null,
    kbModel: r.kbModel ?? null,
    scrapeStatus: r.scrapeStatus,
    httpStatus: r.httpStatus ?? null,
    status: r.status ?? "active",
    notes: r.notes ?? [],
    site: r.site,
    lastScrapedAt: r.scrapedAt,
  };
}

// merge extracted refresh data into existing record; refresh always wins over
// paste-filled data (extractors are the source of truth once they work),
// but never destroys better previous data and never overwrites manual edits
function mergeRefresh(rec, r) {
  const manual = new Set(rec.manualFields || []);
  for (const [k, v] of Object.entries(normalize(r))) {
    if (k === "status") continue;
    if (k === "images") {
      // only grow: a worse/blocked fetch must not erase archived photo links
      if (Array.isArray(v) && (!Array.isArray(rec.images) || v.length > rec.images.length)) rec.images = v;
      continue;
    }
    if (k === "description") {
      // fill only when missing or clearly truncated
      if (v && (!rec.description || String(rec.description).trim().length < String(v).trim().length)) rec.description = v;
      continue;
    }
    if (manual.has(k)) continue;
    if (v != null && v !== "") rec[k] = v;
  }
  if (r.status === "removed") rec.status = "removed";
  if (r.notes?.length) rec.notes = [...new Set([...(rec.notes || []), ...r.notes])].slice(-5);
  rec.lastScrapedAt = r.scrapedAt;
  // never downgrade: a blocked fetch doesn't erase previously-good data
  if (r.scrapeStatus !== "blocked") rec.scrapeStatus = r.scrapeStatus;
  rec.httpStatus = r.httpStatus;
}

// re-derive brand/model/type/kbModel/powerKw for every listing with the current
// extraction logic (fixes mis-parsed data without network access; idempotent)
async function reenrichAll(listings) {
  let changed = 0;
  for (const rec of listings) {
    const manual = new Set(rec.manualFields || []);
    const before = JSON.stringify([rec.brand, rec.model, rec.type, rec.powerKw, rec.kbModel]);
    const source = `${rec.title || ""} ${rec.model || ""} ${rec.description || ""}`;

    // dealer sites sometimes scrape their own shop name as the brand
    if (!manual.has("brand") && (!rec.brand || brandIsSiteSelf(rec.brand, rec.site))) {
      rec.brand = canonicalBrand(extractBrand(source) || extractBrand(rec.title || "")) || null;
    } else if (!manual.has("brand") && rec.brand) {
      rec.brand = canonicalBrand(rec.brand);
    }
    if (!manual.has("model") && !rec.model) {
      rec.model = extractModelFromTitle(rec.title || source, rec.brand);
    }

    const mm = matchModel(rec.brand, `${rec.title || ""} ${rec.model || ""} ${source.slice(0, 400)}`);
    if (mm) {
      rec.kbModel = { stockKw: mm.stockKw, kg: mm.kg, restrictedAvailable: mm.restrictedAvailable, type: mm.type };
      if (!manual.has("model") && rec.model) {
        const normRec = rec.model.replace(/\s+/g, "").toLowerCase();
        const normKb = (mm.name || "").replace(/\s+/g, "").toLowerCase();
        if (normRec === normKb) rec.model = mm.name; // canonicalize spacing: "CBR 500 R" -> "CBR500R"
        else if (normKb.includes(normRec)) rec.model = mm.name; // "Monster" -> KB "Monster 696"
        // otherwise keep the ad's fuller phrasing (e.g. "MT-07 Naked")
      }
      if (!manual.has("powerKw") && rec.powerKw == null && mm.stockKw != null) rec.powerKw = mm.stockKw;
      // ad says "limitada" (A2-restricted by seller): cap power at 35 kW
      if (!manual.has("powerKw") && /limitad|restringid/i.test(source) && rec.powerKw != null && rec.powerKw > 35 && mm.restrictedAvailable) {
        rec.powerKw = 35;
        if (!rec.notes?.includes("ad says 'limitada' — power capped to 35 kW (A2 restricted)")) {
          rec.notes = [...(rec.notes || []), "ad says 'limitada' — power capped to 35 kW (A2 restricted)"].slice(-5);
        }
      }
      if (!manual.has("type") && (rec.type == null || rec.type === "other")) rec.type = mm.type || detectType(`${rec.title || ""} ${rec.model || ""}`);
    }
    if ((!rec.type || rec.type === "other") && !manual.has("type")) {
      rec.type = detectType(`${rec.title || ""} ${rec.model || ""}`);
    }
    if (!rec.title && (rec.brand || rec.model)) {
      rec.title = `${rec.brand || ""} ${rec.model || ""}`.trim() || null;
    }
    rec.a2 = await a2Check(rec);
    rec.insurance = await estimateInsurance(rec);
    if (JSON.stringify([rec.brand, rec.model, rec.type, rec.powerKw, rec.kbModel]) !== before) changed++;
  }
  return changed;
}

async function applyManualPaste(rec, id) {
  const pastePath = join(ROOT, "inbox", `${id}.txt`);
  if (!(await exists(pastePath))) return;
  const text = await readFile(pastePath, "utf8");
  const parsed = await parseAdText(text);
  let touched = false;
  for (const [k, v] of Object.entries(parsed)) {
    if (v != null && rec[k] == null) { rec[k] = v; touched = true; }
  }
  if (parsed.kbModel) rec.kbModel = parsed.kbModel;
  if (touched) {
    rec.manualFields = [...new Set([...(rec.manualFields || []), ...Object.keys(parsed).filter((k) => parsed[k] != null)])];
    rec.scrapeStatus = "ok-pasted-text";
    rec.notes = [...new Set([...(rec.notes || []), "filled from pasted ad text"])].slice(-5);
  }
}

async function main() {
  const listings = await readListings(join(DATA_DIR, "listings.json"));
  let links = [];
  try {
    links = (await readFile(join(ROOT, "links.txt"), "utf8"))
      .split("\n").map((s) => s.trim())
      .filter(Boolean).filter((l) => !l.startsWith("#"));
  } catch {
    links = [];
  }

  const known = new Set(listings.map((l) => l.id));
  const newLinks = links.filter((l) => !known.has(listingId(l)));

  console.log(`Links: ${links.length} total, ${newLinks.length} new, ${listings.length} tracked\n`);

  if (!reenrichOnly) {
    // 1. New links
    for (const link of newLinks) {
      const id = listingId(link);
      console.log(`NEW  ${link}`);
      const r = await extract(link);
      const rec = { id, url: link, addedAt: nowIso(), favorite: false, manualFields: [], priceHistory: [] };
      Object.assign(rec, normalize(r));
      if (r.scrapeStatus !== "ok") await applyManualPaste(rec, id);
      if (rec.price) rec.priceHistory = [{ date: today(), price: rec.price }];
      rec.a2 = await a2Check(rec);
      rec.insurance = await estimateInsurance(rec);
      listings.push(rec);
      console.log(`     -> ${rec.scrapeStatus} | ${rec.brand ?? "?"} ${rec.model ?? ""} ${rec.price ? rec.price + " eur" : ""} ${rec.km ? rec.km + " km" : ""} ${rec.year ?? ""}`);
    }

    // 2. Refresh existing
    if (!newOnly) {
      for (const rec of listings) {
        if (rec.status === "removed") continue;
        console.log(`CHK  ${rec.url}`);
        const r = await extract(rec.url);
        if (r.scrapeStatus === "removed-link") {
          rec.status = "removed";
          rec.removedAt = nowIso();
          console.log(`     -> REMOVED (data kept)`);
          continue;
        }
        mergeRefresh(rec, r);
        if (r.scrapeStatus !== "ok" && rec.scrapeStatus !== "ok") await applyManualPaste(rec, rec.id);
        if (r.price != null && rec.price !== r.price) {
          const old = rec.price;
          rec.price = r.price;
          rec.priceHistory = [...(rec.priceHistory || []), { date: today(), price: r.price }];
          console.log(`     -> price change ${old} -> ${r.price} (${diffPrice(old, r.price)}%)`);
        }
        rec.a2 = await a2Check(rec);
        rec.insurance = await estimateInsurance(rec);
        console.log(`     -> ${rec.scrapeStatus} | status=${rec.status}`);
      }
    }

    // 3. Archive images (survive ad deletion) + save
    const { downloadImages } = await import("./download-images.mjs");
    const archived = await downloadImages(listings);
    if (archived) console.log(`images archived: ${archived} files`);
  }

  // 4. Re-derive brand/model/type/power with the current logic (no network)
  const changed = await reenrichAll(listings);
  if (changed) console.log(`reenrich: updated fields on ${changed} listing(s)`);

  await writeJson(join(DATA_DIR, "listings.json"), listings);
  await writeCsv(listings);

  const { buildDashboard } = await import("./build-dashboard.mjs");
  await buildDashboard();

  const ok = listings.filter((l) => l.scrapeStatus === "ok" || l.scrapeStatus === "ok-pasted-text").length;
  const manual = listings.filter((l) => l.scrapeStatus === "needs-manual").length;
  const blocked = listings.filter((l) => l.scrapeStatus === "blocked").length;
  const removed = listings.filter((l) => l.status === "removed").length;
  console.log(`\nSummary: ${listings.length} listings | ok ${ok} | needs-manual ${manual} | blocked ${blocked} | removed ${removed}`);
  console.log(`CSV written: data/export.csv`);
}

async function writeCsv(listings) {
  const cols = ["id","site","brand","model","type","year","km","price","currency","powerKw","powerCv","cc","a2legal","a2reason","insMin","insMax","status","location","seller","addedAt","lastScrapedAt","title","url"];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = listings.map((l) =>
    [
      l.id, l.site, l.brand, l.model, l.type, l.year, l.km, l.price, l.currency,
      l.powerKw, l.powerCv, l.cc,
      l.a2?.legal === true ? "si" : l.a2?.legal === false ? "no" : "?",
      l.a2?.reason,
      l.insurance?.min, l.insurance?.max,
      l.status, l.location, l.seller, l.addedAt, l.lastScrapedAt, l.title, l.url,
    ].map(esc).join(";")
  );
  const csv = "\ufeff" + cols.join(";") + "\n" + rows.join("\n") + "\n";
  await writeFile(join(DATA_DIR, "export.csv"), csv, "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
