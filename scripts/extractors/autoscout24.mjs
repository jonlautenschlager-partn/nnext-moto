// AutoScout24 extractor.
// Detail pages (/anuncios/...) are bot-blocked and return a soft search page.
// Strategy: read the embedded "listings":[...] JSON blob present on search pages;
// if the blob contains our listing id, extract full data from it.
// If the URL is a detail URL and no blob / id missing -> note it (blocked or removed).

function parsePowerField(s) {
  // "70 kW (95 CV)" / "54 kW (74 CV)"
  if (!s) return {};
  const kw = s.match(/([\d.,]+)\s*k?W/i);
  const cv = s.match(/([\d.,]+)\s*(?:CV|PS)/i);
  const num = (x) => (x ? parseFloat(x.replace(/\./g, "").replace(",", ".")) : null);
  return { powerKw: num(kw?.[1]), powerCv: num(cv?.[1]) };
}

function parseKm(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.,]+)\s*km/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  return isFinite(n) ? Math.round(n) : null;
}

function parseYear(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{2})\/(\d{4})/);
  if (m) return parseInt(m[2], 10);
  const y = String(s).match(/\b(19[89]\d|20[0-3]\d)\b/);
  return y ? parseInt(y[1], 10) : null;
}

function parseCc(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.,]+)\s*cm/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  return isFinite(n) ? Math.round(n) : null;
}

function niceImage(u) {
  if (!u) return null;
  return u.replace(/\/\d+x\d+\.webp$/, "/640x480.jpg");
}

function findListingsBlob(html) {
  const i = html.indexOf('"listings":[');
  if (i < 0) return null;
  const start = i + '"listings":'.length;
  let depth = 0;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function idFromUrl(url) {
  const m = url.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

export const host = "autoscout24.es";

const TYPE_WORDS = {
  naked: "naked",
  scooter: "scooter",
  custom: "custom",
  touring: "touring",
  enduro: "enduro",
  trial: "enduro",
  motocross: "enduro",
  clásica: "classic",
  clasica: "classic",
  sport: "sport",
  superbike: "sport",
  rally: "trail",
  adventure: "trail",
  trail: "trail",
};

function parseSoftTitle(title) {
  // e.g. "Yamaha MT-07 Naked en Negro ocasión en Rivas-Vaciamadrid por € 4.000"
  const out = {};
  if (!title) return out;
  const split = title.match(/^(.+?)\s+(?:ocasión|nueva|nuevo)\s+en\s+(.+?)\s+por\s+€?\s*([\d.,]+)/i);
  if (!split) return out;
  const head = split[1].trim(); // "Yamaha MT-07 Naked en Negro"
  out.location = split[2].trim();
  const price = parseFloat(split[3].replace(/\./g, "").replace(",", "."));
  if (isFinite(price)) out.price = Math.round(price);

  // color: "<...> en <Color>" at the end of head
  const colorM = head.match(/(?:^|\s)en\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñü]+)$/);
  if (colorM) {
    out.color = colorM[1];
    out._headNoColor = head.slice(0, colorM.index).trim();
  } else {
    out._headNoColor = head;
  }
  const h = out._headNoColor;
  // type word: "Yamaha MT-07 Naked" -> naked
  const typeM = h.match(/\b(Naked|Scooter|Custom|Touring|Enduro|Trial|Motocross|Clásica|Clasica|Sport|Superbike|Rally|Adventure|Trail)\b/i);
  if (typeM) out.type = TYPE_WORDS[typeM[1].toLowerCase()] || null;
  // brand: first word if it matches known brand list
  const brandM = h.match(/^([A-Za-zÁÉÍÓÚÑ-]+(?:\s[A-Za-z]+)?)/);
  if (brandM) {
    const cand = brandM[1];
    const known = ["Yamaha","Honda","Kawasaki","Suzuki","KTM","Aprilia","Triumph","BMW","Ducati","Moto Guzzi","Piaggio","Vespa","Benelli","CFMoto","Voge","Royal Enfield","Husqvarna","GasGas","MV Agusta","SYM","Kymco","Zontes","Fantic","Brixton","Harley"];
    for (const k of known) if (h.toLowerCase().startsWith(k.toLowerCase())) { out.brand = k; break; }
  }
  // model: whatever remains after brand and before type word
  if (out.brand) {
    let rest = h.slice(out.brand.length).trim();
    if (out.type) {
      const idx = rest.toLowerCase().lastIndexOf(out.type.toLowerCase());
      if (idx >= 0) rest = rest.slice(0, idx).trim();
    }
    if (rest) out.model = rest;
    out.title = h;
  }
  return out;
}

export function parse({ html, url, data }) {
  const isDetailUrl = /\/anuncios\//.test(url);
  const blob = findListingsBlob(html);
  const wanted = idFromUrl(url);

  if (isDetailUrl && !blob) {
    // soft page: mine the real <title> tag (og:title is generic)
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const soft = parseSoftTitle(m?.[1]?.trim());
    const got = Object.keys(soft).filter((k) => !k.startsWith("_")).length;
    if (got >= 2) {
      delete soft._headNoColor;
      return {
        ...soft,
        scrapeStatus: "ok",
        notes: ["extracted from AS24 soft page (detail blocked for bots)"],
      };
    }
    return { scrapeStatus: "blocked", notes: ["AS24 detail bot-blocked; paste ad text or use browser"] };
  }

  let listing = null;
  if (blob && wanted) listing = blob.find((l) => l.id === wanted);
  if (isDetailUrl && blob && !listing) {
    return { scrapeStatus: "removed", notes: ["AS24: listing id not in page data — likely removed/sold"] };
  }

  const out = {};
  const src = listing || (blob && !isDetailUrl ? blob[0] : null);
  if (!src) return out;

  const v = src.vehicle || {};
  const title = [v.make, v.model, v.variant].filter(Boolean).join(" ");
  if (title) out.title = title;
  if (v.make) out.brand = v.make;
  if (v.model) out.model = v.model;
  if (src.price?.priceRaw != null) {
    out.price = src.price.priceRaw;
    out.currency = "EUR";
  }
  out.km = parseKm(v.mileageInKm);
  out.cc = parseCc(v.engineDisplacementInCCM);
  if (v.fuel) out.fuel = v.fuel;
  if (v.transmission) out.gearbox = v.transmission;
  if (v.offerType === "N") out.condition = "nuevo";
  else if (v.offerType === "U") out.condition = "usado";

  const details = (src.vehicleDetails || []).map((d) => d.data || "");
  for (const d of details) {
    if (/kW|CV/i.test(d)) {
      Object.assign(out, parsePowerField(d));
      break;
    }
  }
  for (const d of details) {
    const y = parseYear(d);
    if (y && d.match(/\//)) { out.year = y; break; }
  }
  if (src.location?.city) out.location = src.location.city;
  const sellerType = src.seller?.type;
  if (sellerType) out.seller = /private|particular/i.test(sellerType) ? "particular" : "professional";
  const imgs = (src.images || []).map(niceImage).filter(Boolean);
  if (imgs.length) out.images = imgs.slice(0, 8);

  return out;
}
