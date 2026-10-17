import { readJson, writeJson, listingId, siteOf, cleanText, extractPrice, extractKm, extractYear, extractCvKw, extractCc, extractBrand, extractModelFromTitle, brandIsSiteSelf, titleFromUrlSlug, saysRestricted, detectType, parseEsNumber, nowIso } from "./lib.mjs";
import { isListingPage } from "./extractors/cochesnet.mjs";
import { a2Check, matchModel } from "./a2.mjs";
import { estimateInsurance } from "./insurance.mjs";
import { parseAdText } from "./parse-text.mjs";
import { DATA_DIR, ROOT, today, diffPrice } from "./lib.mjs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "accept-language": "es-ES,es;q=0.9,en;q=0.8",
  accept: "text/html,application/xhtml+xml",
};

export async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, html: "", error: String(e.message || e) };
  }
}

// motos.coches.net blocks datacenter IPs with a JS/captcha interstitial. The
// reader renders the page from a browser-capable backend, so the extractor can
// still get price/km/description/gallery. Best-effort: only used when the
// direct page is a challenge and the reader returns the actual listing.
const JINA_ENABLED = process.env.NNEXT_JINA_FALLBACK !== "0";
async function fetchViaReader(url) {
  const headers = { "X-Return-Format": "html", accept: "text/html,application/xhtml+xml" };
  if (process.env.JINA_API_KEY) headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(Number(process.env.NNEXT_JINA_TIMEOUT_MS || 60000)),
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } catch (e) {
    return { ok: false, status: 0, html: "", error: String(e.message || e) };
  }
}

// ---- JSON-LD extraction (tier 1) ----
export function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch {
      // some sites embed multiple objects separated by newlines or comments
      const chunk = m[1].replace(/^\/\*[\s\S]*?\*\//, "").trim();
      try {
        blocks.push(JSON.parse(chunk));
      } catch {
        /* skip */
      }
    }
  }
  return blocks;
}

function* walkLd(node) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walkLd(n);
    return;
  }
  if (typeof node === "object") {
    yield node;
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") yield* walkLd(v);
    }
  }
}

function ldText(v) {
  if (v == null) return null;
  if (typeof v === "string") return cleanText(v);
  if (typeof v === "number") return String(v);
  if (v["@value"]) return cleanText(String(v["@value"]));
  if (v["value"] != null) return cleanText(String(v["value"]));
  if (v["name"]) return cleanText(v["name"]);
  return null;
}

export function parseVehicleLd(html, url) {
  const blocks = extractJsonLd(html);
  if (!blocks.length) return null;
  const out = {};
  for (const top of blocks) {
    for (const node of walkLd(top)) {
      const types = [].concat(node["@type"] || []);
      const isProduct = types.some((t) => /product|vehicle|car|motorcycle/i.test(t));
      if (node.offers && !out._offer) out._offer = node.offers;
      if (isProduct) {
        out.title ??= ldText(node.itemOffered?.name) || ldText(node.name);
        out.brand ??= ldText(node.brand && (node.brand.name || node.brand)) || (typeof node.brand === "string" ? node.brand : null);
        out.model ??= ldText(node.model);
        out.year ??= parseInt(ldText(node.vehicleModelDate) || ldText(node.productionDate) || ldText(node.dateVehicleFirstRegistered) || "", 10) || null;
        const mileage = node.mileageFromOdometer;
        if (out.km == null && mileage != null) out.km = parseEsNumber(typeof mileage === "object" ? mileage.value : mileage);
        if (out.cc == null && node.vehicleEngine) out.cc = parseEsNumber(ldText(node.vehicleEngine.engineDisplacement || node.vehicleEngine.displacement));
        if (out.fuel == null) out.fuel = ldText(node.fuelType);
        if (out.gearbox == null) out.gearbox = ldText(node.vehicleTransmission);
        if (out.color == null) out.color = ldText(node.color);
        if (out.images == null) {
          const img = node.image;
          out.images = Array.isArray(img) ? img.map(String).slice(0, 6) : img ? [String(img)] : null;
        }
        if (out.price == null && node.offers) {
          const offers = [].concat(node.offers);
          const o = offers[0];
          // some sites (cuimo) use capital-P "Price"; AggregateOffer may only have lowPrice
          const raw = o?.price ?? o?.Price ?? o?.PRICE ?? o?.lowPrice ?? o?.LowPrice;
          if (o && raw != null) {
            out.price = parseEsNumber(raw);
            out.currency = o.priceCurrency || "EUR";
            out.availability = ldText(o.availability);
          }
        }
        if (out.description == null && node.description) out.description = cleanText(String(node.description));
      }
    }
  }
  // some sites put offers as separate Product Offer node
  if (out.price == null && out._offer) {
    const o = [].concat(out._offer)[0];
    const raw = o?.price ?? o?.Price ?? o?.PRICE ?? o?.lowPrice;
    if (o && raw != null) {
      out.price = parseEsNumber(raw);
      out.currency = o.priceCurrency || "EUR";
    }
  }
  delete out._offer;
  const hasData = out.title || out.price || out.km || out.brand;
  return hasData ? out : null;
}

// ---- meta/og fallback (tier 1b) ----
export function parseMeta(html, url) {
  const get = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"));
    return m ? cleanText(m[1]) : null;
  };
  const title = get("og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? null);
  const description = get("og:description") || get("description");
  const image = get("og:image");
  if (!title && !image) return null;
  return {
    title: title ? cleanText(title) : null,
    description: description ? cleanText(description) : null,
    images: image ? [image] : null,
  };
}

// enrich partial data with regex heuristics over visible text
export function enrichFromText(data, html, url) {
  // strip tags crudely to get visible text
  const text = cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).slice(0, 8000);

  if (data.price == null) data.price = extractPrice(text);
  if (data.km == null) data.km = extractKm(text);
  if (data.year == null) data.year = extractYear(text);
  const { cv, kw } = extractCvKw(text);
  if (data.powerCv == null && cv) data.powerCv = cv;
  if (data.powerKw == null && kw) data.powerKw = kw;
  if (data.cc == null) data.cc = extractCc(text);
  // dealer-site JSON-LD sometimes says brand: <the shop itself> (e.g. Cuimo) — drop it
  if (data.brand && brandIsSiteSelf(data.brand, siteOf(url))) data.brand = null;
  if (data.brand == null) data.brand = extractBrand(text);
  // type: from title/model/KB only — body text pollutes with nav/menu words
  if (data.type == null || data.type === "other") data.type = detectType((data.title || "") + " " + (data.model || ""));
  if (data.brand && data.model == null) data.model = extractModelFromTitle(data.title || text.slice(0, 120), data.brand);
  // generic fallback: blocked pages still expose the item name in the URL slug
  if (!data.title) data.title = titleFromUrlSlug(url);

  // price/km often in title too: "Yamaha MT-07 2021 - 6.900 €"
  const titleSource = data.title || "";
  if (data.price == null) data.price = extractPrice(titleSource);
  if (data.km == null) data.km = extractKm(titleSource);
  if (data.year == null) data.year = extractYear(titleSource);

  // brand -> model via KB
  const mm = matchModel(data.brand, (data.title || "") + " " + text.slice(0, 400));
  if (mm) {
    data.model ??= mm.name;
    data.kbModel = { stockKw: mm.stockKw, kg: mm.kg, restrictedAvailable: mm.restrictedAvailable, type: mm.type };
    data.brand ??= mm.make;
    if (data.type === "other" || !data.type) data.type = mm.type;
    // KB knows the stock power — fill it when the page doesn't state one
    if (data.powerKw == null && mm.stockKw != null) data.powerKw = mm.stockKw;
    // ad says the bike IS A2-restricted: cap stated power at 35 kW. Only the
    // ad's own title/description counts — page boilerplate contains phrases
    // like "responsabilidad limitada", and "(No Limitada)" must NOT match.
    const adText = `${data.title || ""} ${data.description || ""}`;
    if (saysRestricted(adText) && data.powerKw != null && data.powerKw > 35 && mm.restrictedAvailable) {
      data.powerKw = 35;
      data.notes = [...(data.notes || []), "ad says 'limitada' — power capped to 35 kW (A2 restricted)"];
    }
  }
  return data;
}

// ---- site-specific extractors (tier 2) ----
async function loadExtractors() {
  const dir = join(ROOT, "scripts", "extractors");
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".mjs"));
  } catch {
    return [];
  }
  const mods = [];
  for (const f of files) {
    try {
      const mod = await import(join(dir, f));
      if (mod.host) mods.push(mod);
    } catch (e) {
      console.error(`extractor ${f} failed to load:`, e.message);
    }
  }
  return mods;
}

export async function extract(url) {
  const site = siteOf(url);
  const result = {
    url,
    site,
    scrapedAt: nowIso(),
    scrapeStatus: "failed",
    httpStatus: null,
    notes: [],
  };

  const page = await fetchPage(url);
  result.httpStatus = page.status;

  if (!page.ok) {
    if (page.status === 404 || page.status === 410) {
      result.status = "removed";
      result.scrapeStatus = "removed-link";
      result.notes.push(`HTTP ${page.status} — ad likely removed/sold`);
    } else if (page.status === 403 || page.status === 429 || page.status === 0) {
      result.scrapeStatus = "blocked";
      result.notes.push(`HTTP ${page.status || "network"} — site blocked automated access; needs paste-text or screenshot`);
    } else {
      result.notes.push(`HTTP ${page.status} unexpected`);
    }
    return result;
  }

  let html = page.html;

  // bot-challenge pages (200 with challenge markup): never enrich from them
  const challenged = /cf-chl|challenge-platform|Just a moment|Attention Required|captcha|Enable JavaScript and cookies|Ups! Parece que algo no va bien/i.test(html.slice(0, 5000));
  if (challenged) {
    if (site.endsWith("motos.coches.net") && JINA_ENABLED) {
      const reader = await fetchViaReader(url);
      if (reader.ok && isListingPage(reader.html, url)) {
        html = reader.html;
        result.notes.push("datos vía lector externo (r.jina.ai)");
      } else {
        result.scrapeStatus = "blocked";
        result.notes.push(
          reader.ok
            ? "lector externo devolvió una página sin anuncio (quizá eliminado)"
            : `lector externo no disponible (${reader.error || reader.status})`
        );
        return result;
      }
    } else {
      result.scrapeStatus = "blocked";
      result.notes.push("bot challenge page returned 200 — no data extracted");
      return result;
    }
  }

  // tier 1: JSON-LD
  let data = parseVehicleLd(html, url) || {};
  // tier 1b: meta tags
  const meta = parseMeta(html, url) || {};
  data.title ??= meta.title;
  data.description ??= meta.description;
  data.images ??= meta.images;

  // tier 2: site-specific
  const extractors = await loadExtractors();
  for (const ex of extractors) {
    if (!site.endsWith(ex.host)) continue;
    try {
      const extra = await ex.parse({ html, url, data });
      if (extra) Object.assign(data, Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)));
    } catch (e) {
      result.notes.push(`extractor ${ex.host}: ${e.message}`);
    }
  }

  // tier 1c: heuristics over text
  enrichFromText(data, html, url);

  // extractor-set status wins over generic heuristic
  const extractorStatus = data.scrapeStatus;
  delete data.scrapeStatus;
  if (data.notes?.length) result.notes = [...result.notes, ...data.notes].slice(-5);
  delete data.notes;

  if (extractorStatus === "blocked" || extractorStatus === "removed") {
    result.scrapeStatus = extractorStatus === "removed" ? "removed-link" : "blocked";
  } else {
    const got = ["title", "price", "brand", "km", "year"].filter((k) => data[k] != null);
    result.scrapeStatus = got.length >= 3 ? "ok" : "needs-manual";
    if (result.scrapeStatus === "needs-manual") {
      result.notes.push(`only got: ${got.join(", ") || "nothing"} — paste ad text or screenshot in add-link page`);
    }
  }
  Object.assign(result, data);
  return result;
}
