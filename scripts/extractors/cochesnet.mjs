// extractor for motos.coches.net (Adevinta)
//
// The site serves an anti-bot interstitial ("Ups! Parece que algo no va bien...")
// with HTTP 200 to non-browser clients at every entry point (page + APIs).
// When a real page does load (from a real browser or a future relaxed policy),
// it exposes JSON-LD with offers.price / vehicleModelDate / mileage plus an
// og:image gallery — parse those.
//
// Even when the page is unreachable, the URL path itself carries useful
// structure:
//   /ocasion/honda/cbr_500_r/version_2019____2021-2019-en-valencia-10184533.htm
//   <kind>/<brand>/<model-slug>/version_<range>-<year>-en-<location>-<id>.htm
// cochesnetEnrichFromUrl() turns that into brand/model/year/location so that a
// blocked listing still shows correct identity, A2 verdict and insurance.

import { canonicalBrand, extractBrand } from "../lib.mjs";

export const host = "motos.coches.net";

export function isChallengePage(html) {
  if (!html) return true;
  if (/Ups! Parece que algo no va bien/i.test(html)) return true;
  // challenge pages are tiny (<20KB) and carry no structured data
  if (html.length < 20000 && !/application\/ld\+json/i.test(html)) return true;
  return false;
}

// Full gallery from a rendered listing page. Coches.net repeats the same image
// at several sizes (/95x71cut/, /712x535cut/); keep one base URL per image id.
export function galleryFromHtml(html) {
  if (!html) return [];
  const found = [...html.matchAll(/https:\/\/a\.mcdn\.es\/mnet\/[^"'\s\\]+?\/\d+_g\.jpg/g)].map((m) => m[0]);
  return [...new Set(found)];
}

// The reader fallback can silently land on a catalog page when the ad is gone
// (or when the reader is rate-limited). Only accept a page whose canonical URL
// still points to the listing we asked for.
export function isListingPage(html, url) {
  if (!html) return false;
  let wantedPath;
  try { wantedPath = new URL(url).pathname; } catch { return false; }
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (canonical) {
    try {
      const gotPath = new URL(canonical, "https://motos.coches.net").pathname;
      if (gotPath.replace(/\/+$/, "") !== wantedPath.replace(/\/+$/, "")) return false;
    } catch {
      return false;
    }
  }
  // A real listing carries either JSON-LD offers or its own gallery images.
  return /"offers"|itemcondition|vehicleModelDate/i.test(html) || galleryFromHtml(html).length > 0;
}

// parse a real page (tier 2): JSON-LD + og images layered over tier-1 data
export function parse({ html, url, data }) {
  if (isChallengePage(html)) {
    return { scrapeStatus: "blocked", notes: ["motos.coches.net bot challenge — no page data"] };
  }
  const out = {};
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, block] of ldBlocks) {
    let obj;
    try { obj = JSON.parse(block.trim()); } catch { continue; }
    const objs = Array.isArray(obj) ? obj : [obj];
    for (const o of objs) {
      if (!o || typeof o !== "object") continue;
      if (!out.title && typeof o.name === "string") out.title = o.name.trim();
      if (o.offers) {
        const offers = Array.isArray(o.offers) ? o.offers[0] : o.offers;
        const p = offers?.price ?? offers?.lowPrice;
        if (p != null && out.price == null) {
          const n = parseFloat(String(p).replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
          if (Number.isFinite(n) && n > 0) out.price = Math.round(n);
        }
      }
      if (o.mileageFromOdometer) {
        const mv = typeof o.mileageFromOdometer === "object" ? o.mileageFromOdometer.value : o.mileageFromOdometer;
        const n = parseInt(String(mv).replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n) && out.km == null) out.km = n;
      }
      if (o.vehicleModelDate && out.year == null) {
        const y = parseInt(o.vehicleModelDate, 10);
        if (y >= 1980 && y <= new Date().getFullYear() + 1) out.year = y;
      }
      if (o.vehicleEngine) {
        const e = Array.isArray(o.vehicleEngine) ? o.vehicleEngine[0] : o.vehicleEngine;
        if (e?.engineDisplacement && out.cc == null) {
          const c = parseInt(String(e.engineDisplacement).replace(/[^\d]/g, ""), 10);
          if (Number.isFinite(c) && c >= 40 && c <= 2500) out.cc = c;
        }
      }
      if (typeof o.description === "string" && !out.description) out.description = o.description.trim();
    }
  }
  const og = [...html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => /^https?:\/\//.test(u));
  const imgs = [...galleryFromHtml(html), ...og];
  if (imgs.length) out.images = [...new Set(imgs)].slice(0, 12);
  return out;
}

// URL-path enrichment for blocked pages: brand/model/year/location from the
// /ocasion/<brand>/<model-slug>/...-en-<location>-<id>.htm structure
export function cochesnetEnrichFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)motos\.coches\.net$/i.test(u.hostname)) return null;
    const segs = u.pathname.split("/").filter(Boolean);
    const ocIdx = segs.indexOf("ocasion");
    if (ocIdx === -1) return null;
    const brandSlug = segs[ocIdx + 1] || "";
    const modelSlug = segs[ocIdx + 2] || "";
    const tail = segs[ocIdx + 3] || "";
    const out = { brand: null, modelText: null, year: null, location: null };
    if (brandSlug && brandSlug !== "ocasion") {
      const b = canonicalBrand(extractBrand(brandSlug.replace(/[-_]+/g, " ")));
      if (b) out.brand = b;
    }
    if (modelSlug) out.modelText = modelSlug.replace(/[-_]+/g, " ");
    const ym = tail.match(/-(19[89]\d|20[0-3]\d)(?:-en-|\.htm|$)/);
    if (ym) out.year = parseInt(ym[1], 10);
    const lm = tail.match(/-en-([a-zá-úñ\s]+?)-\d+(?:\.x?html?)?$/i);
    if (lm) {
      const loc = lm[1].replace(/[-_]+/g, " ").trim();
      out.location = loc.charAt(0).toUpperCase() + loc.slice(1);
    }
    return out;
  } catch {
    return null;
  }
}
