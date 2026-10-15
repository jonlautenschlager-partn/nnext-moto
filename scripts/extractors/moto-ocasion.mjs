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

  // availability: dealer marks the ad "reservada" (reserved) / "vendida" (sold).
  // When reserved/sold the shown price is unreliable (reservation fee, related
  // cards) — skip price extraction so the stored real price survives.
  const estado = (html.match(/data-estado="([a-z]+)"/) || [])[1];
  if (estado === "reservada") out.availability = "reserved";
  else if (estado === "vendida") out.availability = "sold";
  const reserved = out.availability != null;

  const ogTitle = (html.match(/property="og:title" content="([^"]+)"/) || [])[1];
  if (ogTitle) out.title = ogTitle.replace(/\s*Moto-Ocasion\s*$/i, "").trim();
  if (out.title) {
    const known = ["Yamaha","Honda","Kawasaki","Suzuki","KTM","Aprilia","Triumph","BMW","Ducati","Moto Guzzi","Piaggio","Vespa","Benelli","CFMoto","Voge","Royal Enfield","Husqvarna","GasGas","MV Agusta","SYM","Kymco","Zontes","Fantic","Brixton","Harley"];
    for (const k of known) {
      if (out.title.toLowerCase().startsWith(k.toLowerCase())) { out.brand = k; break; }
    }
  }

  // MAIN product price: the WooCommerce price element
  // ("5.250&nbsp;<span class="woocommerce-Price-cur...") is THIS bike's price.
  // The moto-price spans include RELATED-bike cards — never trust them first.
  const wooPrice = (html.match(/>([0-9][0-9.,]{1,9})&nbsp;<span class="woocommerce-Price-cur/) || [])[1];
  const wooNum = parseNum(wooPrice);
  if (wooNum && wooNum > 300) {
    out.price = wooNum;
    out.currency = "EUR";
  } else if (!reserved) {
    // fallback 1: the dealer's own Google-feed price for this product
    const gtag = (html.match(/glaGtagData[\s\S]{0,400}?"products":\{[^{]*\{[^}]*"price":(\d+)/) || [])[1];
    if (gtag && +gtag > 300) {
      out.price = +gtag;
      out.currency = "EUR";
    } else {
      // fallback 2 (legacy markup): moto-price-top block without a wishlist
      // button = the main bike; then plain-€ span (no wishlist, no &euro;)
      const priceRe = /class="(?:[^"]*\s)?moto-price(?![-\w])[^"]*"[^>]*>([\s\S]{0,600})/g;
      let pm;
      const mainSegs = [];
      const otherSegs = [];
      while ((pm = priceRe.exec(html))) {
        const seg = pm[1];
        if (/moto-price-top/.test(seg) && !/yith-add-to-w/.test(seg)) mainSegs.push(seg);
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

  // power / cc from the bike's own spec TABLE (structured <th>/<td>), which is
  // immune to related-bike cards; first-occurrence text only as fallback
  const specVal = (label) => {
    const m = html.match(new RegExp(`${label}\\s*</th>[\\s\\S]{0,200}?<td[^>]*>([\\s\\S]{0,40}?)</td>`, "i"));
    return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  };
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const potRaw = specVal("Potencia Máxima") || (text.match(/(\d{1,3})\s*(?:CV|cv|Cv)\b/) || [])[0];
  const ccRaw = specVal("Cilindrada") || (text.match(/(\d{2,4})\s*(?:CC|cc|Cc)\b/) || [])[0];
  const cvM = potRaw ? potRaw.match(/(\d{1,3})/) : null;
  const ccM = ccRaw ? ccRaw.match(/(\d{2,4})/) : null;
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
