// moto-ocasion.com extractor (server-rendered dealer marketplace).
// Structure: p.moto-price (3.750€), .badge-ano (2021), .badge-km (38000 km),
// .badge-carnet (A, A2), og:title "HONDA CBR 500 R -APTA A2- Moto-Ocasion".
function classText(html, cls) {
  // exact token match: "moto-price" must not also match "moto-price-row"/"moto-price-financiacion"
  const re = new RegExp(`class="(?:[^"]*\\s)?${cls}(?![-\\w])[^"]*"[^>]*>([\\s\\S]{0,400}?)</`, "i");
  const m = html.match(re);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseNum(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.,]+)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
  return isFinite(n) ? Math.round(n) : null;
}

export const host = "moto-ocasion.com";

export function parse({ html, url, data }) {
  const out = {};

  const ogTitle = (html.match(/property="og:title" content="([^"]+)"/) || [])[1];
  if (ogTitle) out.title = ogTitle.replace(/\s*Moto-Ocasion\s*$/i, "").trim();
  if (out.title) {
    const known = ["Yamaha","Honda","Kawasaki","Suzuki","KTM","Aprilia","Triumph","BMW","Ducati","Moto Guzzi","Piaggio","Vespa","Benelli","CFMoto","Voge","Royal Enfield","Husqvarna","GasGas","MV Agusta","SYM","Kymco","Zontes","Fantic","Brixton","Harley"];
    for (const k of known) {
      if (out.title.toLowerCase().startsWith(k.toLowerCase())) { out.brand = k; break; }
    }
  }

  // main product price block = the one containing <span class="moto-price-top">
  // (related-bike cards use plain moto-price with &euro; and no top span)
  const priceRe = /class="(?:[^"]*\s)?moto-price(?![-\w])[^"]*"[^>]*>([\s\S]{0,600})/g;
  let pm;
  const mainSegs = [];
  const otherSegs = [];
  while ((pm = priceRe.exec(html))) {
    const seg = pm[1];
    if (/moto-price-top/.test(seg)) mainSegs.push(seg);
    else if (!/yith-add-to-w|&euro;/.test(seg)) otherSegs.push(seg);
  }
  for (const seg of [...mainSegs, ...otherSegs]) {
    const priceNum = parseNum(seg.replace(/<[^>]+>/g, " "));
    if (priceNum && priceNum > 300) {
      out.price = priceNum;
      out.currency = "EUR";
      break;
    }
  }

  const ano = classText(html, "badge-ano");
  const year = parseNum(ano);
  if (year && year >= 1980 && year <= new Date().getFullYear() + 1) out.year = year;

  const kmRaw = classText(html, "badge-km");
  const km = parseNum(kmRaw);
  if (km != null && km >= 0 && km <= 300000) out.km = km;

  const carnet = classText(html, "badge-carnet");
  if (carnet) out.carnet = carnet; // e.g. "A, A2"

  // power / cc from page text (first occurrences belong to this bike's spec table)
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const cvM = text.match(/(\d{1,3})\s*(?:CV|cv|Cv)\b/);
  const ccM = text.match(/(\d{2,4})\s*(?:CC|cc|Cc)\b/);
  const kwM = text.match(/(\d{1,3})\s*kW\b/);
  if (cvM) out.powerCv = parseFloat(cvM[1]);
  if (kwM) out.powerKw = parseFloat(kwM[1]);
  else if (cvM) out.powerKw = Math.round((out.powerCv / 1.36) * 10) / 10;
  if (ccM) out.cc = parseInt(ccM[1], 10);

  const productId = (html.match(/product_id=(\d+)/) || [])[1];
  if (productId) out.productId = productId;

  // gallery: uploads images whose filename contains the product slug (from canonical URL)
  const canon = (html.match(/rel="canonical" href="([^"]+)"/) || html.match(/property="og:url" content="([^"]+)"/) || [])[1];
  if (canon) {
    const slugFull = canon.replace(/\/$/, "").split("/").pop() || "";
    const base = slugFull.replace(/-\d{4,7}[a-z]{0,3}\.?.*$/i, "").replace(/\.html?$/, "");
    if (base.length > 4) {
      const re = new RegExp(`https://www\\.moto-ocasion\\.com/wp-content/uploads/[^"'>\\s]+\\.(?:jpg|jpeg|png|webp)`, "g");
      const found = [];
      let mm;
      while ((mm = re.exec(html))) {
        const u = mm[0];
        const fname = u.split("/").pop().toLowerCase();
        if (fname.includes("icono") || fname.includes("placeholder")) continue;
        if (fname.includes(base) && !found.includes(u)) found.push(u);
      }
      if (found.length) out.images = found.slice(0, 12);
    }
  }
  const ogImg = (html.match(/property="og:image" content="([^"]+)"/) || [])[1];
  if (ogImg && !out.images) out.images = [ogImg];

  const locM = html.match(/class="[^"]*badge-[^"]*location[^"]*"[^>]*>([^<]{0,80})</) || html.match(/(Ubicación|Provincia)[:\s<]*([^<]{3,60})</);
  if (locM) out.location = locM[2] ? locM[2].trim() : null;

  return out;
}
