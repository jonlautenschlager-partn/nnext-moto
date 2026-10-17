import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { extract } from "./scrape.mjs";
import { a2Check, matchModel } from "./a2.mjs";
import { estimateInsurance } from "./insurance.mjs";
import { parseAdText } from "./parse-text.mjs";
import { readListings, writeJson, listingId, DATA_DIR, ROOT, today, nowIso, diffPrice, extractBrand, extractModelFromTitle, brandIsSiteSelf, canonicalBrand, saysRestricted, titleFromUrlSlug, detectType } from "./lib.mjs";
import { cochesnetEnrichFromUrl } from "./extractors/cochesnet.mjs";

// slugs/promoted lines that carry no human title — rebuild from brand+model
const JUNK_TITLE = /(^version\b|\bhtm\b|^ubicaci[oó]n:|^localidad:)/i;

const args = process.argv.slice(2);
const newOnly = args.includes("--new-only");
const localNew = args.includes("--local-new");
const quiet = args.includes("--quiet");
const reenrichOnly = args.includes("--reenrich-only");
const reparsePastes = args.includes("--reparse-pastes");

// A listing created by CI (Wallapop 403, coches.net challenge) looks "known"
// but still lacks the data only the Mac/reader can fetch. The 15-minute import
// job refreshes those instead of waiting for the next full nightly.
function needsLocalRefresh(rec) {
  if (rec.status === "removed") return false;
  const hasImages = (rec.images?.length || 0) > 0 || (rec.localImages?.length || 0) > 0;
  if (rec.site === "es.wallapop.com") {
    return rec.scrapeStatus !== "ok" || !hasImages || rec.price == null;
  }
  if (rec.site === "motos.coches.net") {
    const last = Date.parse(rec.lastScrapedAt || 0);
    const stale = !Number.isFinite(last) || Date.now() - last > 6 * 60 * 60 * 1000;
    return stale && (rec.scrapeStatus !== "ok" || !hasImages || rec.price == null || rec.km == null);
  }
  return false;
}

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
// A successful scrape may replace paste-derived values for these structured
// fields (the ad is the source of truth). Free-text fields such as title and
// seller stay paste-derived unless the user edits them from the dashboard.
const SCRAPE_OVER_PASTE = new Set([
  "price", "km", "year", "powerKw", "powerCv", "cc",
  "location", "postalCode", "condition", "availability", "lastModified",
]);

function mergeRefresh(rec, r) {
  const manual = new Set(rec.manualFields || []);
  const paste = new Set(rec.pasteFields || []);
  const user = new Set(rec.userFields || []);
  const rank = { ok: 3, "ok-pasted-text": 2, "needs-manual": 1, blocked: 0, failed: 0, "removed-link": 0 };
  for (const [k, v] of Object.entries(normalize(r))) {
    if (k === "status" || k === "scrapeStatus") continue;
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
    if (user.has(k)) continue;
    if (manual.has(k) && !(paste.has(k) && SCRAPE_OVER_PASTE.has(k))) continue;
    if (k === "price" && v != null && v !== "" && rec.price != null && rec.price !== v) {
      // record the change BEFORE overwriting (history tracks real price moves)
      rec.priceHistory = [...(rec.priceHistory || []), { date: today(), price: v }];
    }
    if (v != null && v !== "") rec[k] = v;
  }
  if (r.status === "removed") rec.status = "removed";
  if (r.notes?.length) rec.notes = [...new Set([...(rec.notes || []), ...r.notes])].slice(-5);
  rec.lastScrapedAt = r.scrapedAt;
  // never downgrade: blocked/needs-manual must not erase a previously-good state
  if ((rank[r.scrapeStatus] ?? 0) > (rank[rec.scrapeStatus] ?? 0)) rec.scrapeStatus = r.scrapeStatus;
  rec.httpStatus = r.httpStatus;
}

// re-apply the paste parser over stored inbox texts. The paste is the source of
// truth only for fields it originally filled (manualFields) or for fields that
// are still null — a successful scrape always keeps its scraped values. This
// makes it safe to replay after parser improvements (repairs old mis-parses).
const PASTE_FIELDS = ["title","brand","model","type","year","km","price","cc","powerCv","powerKw","location","seller","kbModel","description"];
const STATUS_RANK = { ok: 3, "ok-pasted-text": 2, "needs-manual": 1, blocked: 0, failed: 0, "removed-link": 0 };
async function reparsePastesAll(listings) {
  let n = 0;
  const SAFE = new Set(["km", "price", "year", "powerKw", "powerCv", "cc"]);
  for (const rec of listings) {
    const pastePath = join(ROOT, "inbox", `${rec.id}.txt`);
    if (!(await exists(pastePath))) continue;
    const text = await readFile(pastePath, "utf8");
    const parsed = await parseAdText(text);
    const manual = new Set(rec.manualFields || []);
    const paste = new Set(rec.pasteFields || []);
    const user = new Set(rec.userFields || []);
    const touched = [];
    for (const k of PASTE_FIELDS) {
      const v = parsed[k];
      // stale paste flag: marked manual but the field is empty and the parser
      // has no value (e.g. price from an old repair-quote mis-parse)
      if (v == null || v === "") {
        if (manual.has(k) && (rec[k] == null || rec[k] === "")) { manual.delete(k); paste.delete(k); }
        // paste-derived junk the improved parser now rejects reverts to null,
        // so a working scrape can fill it (km 300, price 500 from a quote)
        if (manual.has(k) && rec[k] != null) {
          if (k === "km" && rec.km < 500) { rec.km = null; manual.delete(k); paste.delete(k); touched.push("km"); continue; }
          if (k === "price" && rec.price < 1500) { rec.price = null; manual.delete(k); paste.delete(k); touched.push("price"); continue; }
        }
        continue;
      }
      // a generic "other" type must never clobber a concrete classification
      if (k === "type" && v === "other" && rec.type && rec.type !== "other") continue;
      if (user.has(k)) continue;
      const isManual = manual.has(k);
      const isMissing = rec[k] == null || rec[k] === "";
      const same = String(rec[k] ?? "") === String(v);
      if (!isManual && !isMissing) {
        if (same) paste.add(k); // record provenance; scraped value still wins
        continue;
      }
      if (isManual && !isMissing && !same && !SAFE.has(k)) continue; // preserve free-text paste/user value
      // a successful scrape is fresher than the paste: never replace its value
      if (rec.scrapeStatus === "ok" && !isMissing && !same) continue;
      if (same) { paste.add(k); continue; }
      rec[k] = v;
      touched.push(k);
      manual.add(k);
      paste.add(k);
    }
    rec.manualFields = [...manual];
    rec.pasteFields = [...paste];
    if (!touched.length) continue;
    if ((STATUS_RANK[rec.scrapeStatus] ?? 0) < STATUS_RANK["ok-pasted-text"]) rec.scrapeStatus = "ok-pasted-text";
    if (!rec.notes?.includes("filled from pasted ad text")) {
      rec.notes = [...new Set([...(rec.notes || []), "filled from pasted ad text"])].slice(-5);
    }
    console.log(`REPASTE ${rec.id}: ${touched.join(", ")}`);
    n++;
  }
  return n;
}

// re-derive brand/model/type/kbModel/powerKw for every listing with the current
// extraction logic (fixes mis-parsed data without network access; idempotent)
async function reenrichAll(listings) {
  let changed = 0;
  const LIMITADA_NOTE = "ad says 'limitada' — power capped to 35 kW (A2 restricted)";
  for (const rec of listings) {
    const manual = new Set(rec.manualFields || []);
    const user = new Set(rec.userFields || []);
    const before = JSON.stringify([rec.brand, rec.model, rec.type, rec.powerKw, rec.kbModel, rec.title]);
    const source = `${rec.title || ""} ${rec.model || ""} ${rec.description || ""}`;

    // dealer sites sometimes scrape their own shop name as the brand
    if (!manual.has("brand") && (!rec.brand || brandIsSiteSelf(rec.brand, rec.site))) {
      rec.brand = canonicalBrand(extractBrand(source) || extractBrand(rec.title || "")) || null;
    } else if (!manual.has("brand") && rec.brand) {
      rec.brand = canonicalBrand(rec.brand);
    }

    // URL-path enrichment (motos.coches.net hides brand/model/year/location in
    // the path — fills nulls only, never overwrites manual edits or scrapes)
    if (!manual.has("model") && (rec.model === "Version" || JUNK_TITLE.test(rec.model || ""))) rec.model = null;
    const urlEnrich = rec.site?.endsWith("motos.coches.net") ? cochesnetEnrichFromUrl(rec.url) : null;
    if (urlEnrich) {
      if (!manual.has("brand") && !rec.brand && urlEnrich.brand) rec.brand = urlEnrich.brand;
      if (urlEnrich.modelText) {
        const mmUrl = matchModel(rec.brand || urlEnrich.brand, urlEnrich.modelText);
        if (!manual.has("model") && !rec.model && mmUrl) {
          rec.model = mmUrl.name;
          rec.kbModel ??= { stockKw: mmUrl.stockKw, kg: mmUrl.kg, restrictedAvailable: mmUrl.restrictedAvailable, type: mmUrl.type };
        }
      }
      if (!manual.has("year") && rec.year == null && urlEnrich.year) rec.year = urlEnrich.year;
      if (!manual.has("location") && !rec.location && urlEnrich.location) rec.location = urlEnrich.location;
    }

    // title missing, brand-only, or junk from a portal slug: rebuild
    if (!rec.title || JUNK_TITLE.test(rec.title) || rec.title.trim().toLowerCase() === (rec.brand || "").trim().toLowerCase()) {
      rec.title = titleFromUrlSlug(rec.url)
        || (rec.brand && rec.model ? `${rec.brand} ${rec.model}${rec.location ? ` (${rec.location})` : ""}` : null)
        || rec.title
        || null;
    }

    // undo an earlier wrong 'limitada' cap (e.g. "(No Limitada)" ads): reset the
    // power so the KB can fill the real stock value again
    if (!user.has("powerKw") && (rec.notes || []).includes(LIMITADA_NOTE) && !saysRestricted(source)) {
      rec.powerKw = null;
      rec.notes = (rec.notes || []).filter((x) => x !== LIMITADA_NOTE);
    }

    if (!manual.has("model") && !rec.model) {
      rec.model = extractModelFromTitle(rec.title || source, rec.brand);
    }

    const mm = matchModel(rec.brand, `${rec.title || ""} ${rec.model || ""} ${source.slice(0, 400)}`);
    if (mm) {
      rec.kbModel = { stockKw: mm.stockKw, kg: mm.kg, restrictedAvailable: mm.restrictedAvailable, type: mm.type };
      if (!manual.has("model") && !rec.model && mm.name) rec.model = mm.name; // KB fills a missing model
      if (!manual.has("model") && rec.model) {
        const normRec = rec.model.replace(/\s+/g, "").toLowerCase();
        const normKb = (mm.name || "").replace(/\s+/g, "").toLowerCase();
        if (normRec === normKb) rec.model = mm.name; // canonicalize spacing: "CBR 500 R" -> "CBR500R"
        else if (normKb.includes(normRec)) rec.model = mm.name; // "Monster" -> KB "Monster 696"
        // otherwise keep the ad's fuller phrasing (e.g. "MT-07 Naked")
      }
      if (!user.has("powerKw") && rec.powerKw == null && mm.stockKw != null) rec.powerKw = mm.stockKw;
      if (!manual.has("cc") && rec.cc == null && mm.cc) rec.cc = mm.cc;
      // ad says the bike IS A2-restricted: cap power at 35 kW
      if (!user.has("powerKw") && saysRestricted(source) && rec.powerKw != null && rec.powerKw > 35 && mm.restrictedAvailable) {
        rec.powerKw = 35;
        if (!rec.notes?.includes(LIMITADA_NOTE)) {
          rec.notes = [...(rec.notes || []), LIMITADA_NOTE].slice(-5);
        }
      }
      if ((rec.type == null || rec.type === "other") && mm.type && mm.type !== "other") rec.type = mm.type;
    }
    if ((!rec.type || rec.type === "other")) {
      // "other" is a placeholder — upgrading it is always an improvement
      const t = mm?.type || detectType(`${rec.title || ""} ${rec.model || ""}`);
      if (t && t !== "other") rec.type = t;
    }
    if (!rec.title && (rec.brand || rec.model)) {
      rec.title = `${rec.brand || ""} ${rec.model || ""}`.trim() || null;
    }
    rec.a2 = await a2Check(rec);
    rec.insurance = await estimateInsurance(rec, rec.insurance);
    if (JSON.stringify([rec.brand, rec.model, rec.type, rec.powerKw, rec.kbModel, rec.title]) !== before) changed++;
  }
  return changed;
}

async function applyManualPaste(rec, id) {
  const pastePath = join(ROOT, "inbox", `${id}.txt`);
  if (!(await exists(pastePath))) return;
  const text = await readFile(pastePath, "utf8");
  const parsed = await parseAdText(text);
  const applied = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (v != null && rec[k] == null) { rec[k] = v; applied.push(k); }
  }
  if (!applied.length) return;
  rec.manualFields = [...new Set([...(rec.manualFields || []), ...applied])];
  rec.pasteFields = [...new Set([...(rec.pasteFields || []), ...applied])];
  if (parsed.kbModel) rec.kbModel = parsed.kbModel;
  rec.scrapeStatus = "ok-pasted-text";
  rec.notes = [...new Set([...(rec.notes || []), "filled from pasted ad text"])].slice(-5);
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

  if (!reenrichOnly && !reparsePastes) {
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
      rec.insurance = await estimateInsurance(rec, rec.insurance);
      listings.push(rec);
      console.log(`     -> ${rec.scrapeStatus} | ${rec.brand ?? "?"} ${rec.model ?? ""} ${rec.price ? rec.price + " eur" : ""} ${rec.km ? rec.km + " km" : ""} ${rec.year ?? ""}`);
    }

    // 2. Refresh existing (all on full runs; only incomplete local imports on
    // the 15-minute job)
    const refreshList = localNew
      ? listings.filter((rec) => needsLocalRefresh(rec))
      : newOnly
        ? []
        : listings;
    if (refreshList.length) {
      for (const rec of refreshList) {
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
        rec.insurance = await estimateInsurance(rec, rec.insurance);
        console.log(`     -> ${rec.scrapeStatus} | status=${rec.status}`);
      }
    }

    // 3. Archive images (survive ad deletion) + save
    const { downloadImages } = await import("./download-images.mjs");
    const archived = await downloadImages(listings);
    if (archived) console.log(`images archived: ${archived} files`);
  }

  // 4. Re-derive brand/model/type/power with the current logic (no network)
  if (reparsePastes) await reparsePastesAll(listings);
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
