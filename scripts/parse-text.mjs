import {
  extractPrice, extractKm, extractYear, extractCvKw, extractCc,
  extractBrand, extractModelFromTitle, detectType, cleanText,
} from "./lib.mjs";
import { matchModel } from "./a2.mjs";

// Parse pasted ad text (or page text) into structured fields.
// Used when a site blocks the scraper: user pastes the ad content.
//
// IMPORTANT: value extraction runs on a cleaned one-line string, but the
// STRUCTURE (title line, section headers) is read from the raw text —
// cleanText() collapses newlines, which destroyed title/description parsing.
export async function parseAdText(text) {
  const raw = String(text ?? "");
  const t = cleanText(raw);
  const out = {
    title: null,
    brand: null,
    model: null,
    type: null,
    year: null,
    km: null,
    price: null,
    cc: null,
    powerCv: null,
    powerKw: null,
    location: null,
    seller: null,
  };

  out.price = extractPrice(t);
  out.km = extractKm(t);
  out.year = extractYear(t);
  const { cv, kw } = extractCvKw(t);
  if (cv) out.powerCv = cv;
  if (kw) out.powerKw = kw;
  if (out.powerCv && !out.powerKw) out.powerKw = Math.round((out.powerCv / 1.36) * 10) / 10;
  out.cc = extractCc(t);
  out.brand = extractBrand(t);
  out.type = detectType(t);

  // location: match common province names at end of text
  const provs = ["Madrid","Barcelona","Valencia","Sevilla","Zaragoza","Málaga","Murcia","Bilbao",
    "Alicante","Córdoba","Valladolid","Vigo","Gijón","Granada","A Coruña","Vitoria","Pamplona",
    "Santander","Oviedo","Toledo","Guadalajara","Segovia","Ávila","Cuenca","Albacete","Ciudad Real",
    "Salamanca","Burgos","León","Logroño","Huesca","Teruel","Lleida","Tarragona","Girona","Castellón",
    "Cádiz","Huelva","Jaén","Almería","Badajoz","Cáceres","Palma","Ibiza","Las Palmas","Santa Cruz de Tenerife",
    "Melilla","Ceuta"];
  for (const p of provs) {
    if (t.includes(p)) { out.location = p; break; }
  }

  // seller
  if (/\bparticular\b/i.test(t)) out.seller = "particular";
  else if (/concesionario|tienda|ocasi[óo]n professional|distribuidor/i.test(t)) out.seller = "professional";

  // model: match against KB and pick longest model name present
  const mm = await matchModel(out.brand, t);
  if (mm) {
    out.model = mm.name;
    out.kbModel = { stockKw: mm.stockKw, kg: mm.kg, restrictedAvailable: mm.restrictedAvailable };
    if (!out.brand) out.brand = mm.make;
    if (!out.type || out.type === "other") out.type = mm.type;
  }
  if (out.brand && out.model == null) {
    out.model = extractModelFromTitle(t.slice(0, 160), out.brand);
  }

  // ---- structure from RAW text (newlines preserved) ----
  const HEADERS = /^(descripci[oó]n|caracter[ií]sticas|detalles|datos|specs?)\s*:?\s*$/i;
  const BULLET = /^\s*[-•⁃*·]\s*/;
  const lines = raw.split(/\r?\n/).map((s) => s.trim());

  // description: text after the "Descripción" header, or the whole raw text
  let desc = null;
  const hdrIdx = lines.findIndex((l) => HEADERS.test(l));
  if (hdrIdx >= 0) {
    const rest = lines.slice(hdrIdx + 1);
    // stop at the next known section header
    const nextHdr = rest.findIndex((l) => HEADERS.test(l));
    desc = (nextHdr >= 0 ? rest.slice(0, nextHdr) : rest).filter(Boolean).join("\n").trim();
  }
  if (!desc && !/caracter[ií]sticas/i.test(t)) desc = lines.filter(Boolean).join("\n").trim();
  if (desc) {
    // drop a first line that just repeats the listing title
    const dLines = desc.split("\n");
    if (dLines.length > 1 && out.title && dLines[0].trim().toLowerCase() === out.title.trim().toLowerCase()) {
      desc = dLines.slice(1).join("\n").trim();
    }
    out.description = desc || null;
  }

  // title: first meaningful line that is not a header, not a bullet, not a
  // junk phrase; only if the text carries a brand/model context (structured
  // pastes without a title would otherwise promote feature lines to title)
  const SKIP_TITLE = /^(no negociable|precio negociable|[úu]ltimo precio|se vende|vendo|hola|buenas|buenos d[ií]as|atenci[oó]n)\b/i;
  const FIELD_LABEL = /^(kms?|a[ñn]o|estilo|precio|color|cilindrada|potencia|marcas?|modelo|combustible|cambio|matriculaci[oó]n)\s*$/i;
  let title = null;
  if (out.brand || out.model) {
    for (const line of lines) {
      if (!line || HEADERS.test(line) || BULLET.test(line)) continue;
      if (FIELD_LABEL.test(line)) break; // entered the characteristics section
      const s = cleanText(line.replace(/^#+\s*/, ""));
      if (!s || SKIP_TITLE.test(s)) continue;
      if (s.length <= 120) { title = s; break; }
      const firstSentence = s.split(/(?<=\.)\s/)[0] || "";
      if (out.brand && firstSentence.toLowerCase().includes(out.brand.toLowerCase()) && firstSentence.length <= 120) {
        title = firstSentence;
      }
      break;
    }
  }
  if (title) out.title = title;

  return out;
}
