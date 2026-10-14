import {
  extractPrice, extractKm, extractYear, extractCvKw, extractCc,
  extractBrand, detectType, cleanText,
} from "./lib.mjs";
import { matchModel } from "./a2.mjs";

// Parse pasted ad text (or page text) into structured fields.
// Used when a site blocks the scraper: user pastes the ad content.
export async function parseAdText(text) {
  const t = cleanText(text);
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

  // title: first line that isn't a section header
  const HEADERS = /^(descripci[oó]n|caracter[ií]sticas|detalles|datos|specs?)$/i;
  let title = null;
  for (const line of t.split(/\n|·|\|/)) {
    const s = cleanText(line);
    if (!s || HEADERS.test(s)) continue;
    if (s.length <= 120) { title = s; break; }
    break;
  }
  if (title) out.title = title;

  // description: paste format is "Descripción\n<body>\n\nCaracterísticas\nKm\n..." or plain body
  let desc = null;
  const descM = t.match(/descripci[oó]n\s*\n([\s\S]*?)(?:\n\s*caracter[ií]sticas\b|$)/i);
  if (descM) desc = descM[1].trim();
  if (!desc && !/caracter[ií]sticas/i.test(t)) desc = t; // plain body text
  if (desc) {
    // drop title-ish first line if it repeats the listing title
    const lines = desc.split("\n");
    if (lines.length > 1 && out.title && lines[0].trim().toLowerCase() === out.title.trim().toLowerCase()) desc = lines.slice(1).join("\n").trim();
    out.description = desc || null;
  }

  return out;
}
