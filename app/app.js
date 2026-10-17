const OWNER = "jonlautenschlager-partn";
const REPO = "nnext-moto";
const LISTINGS_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/data/listings.json`;
const IMG_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/data/images`;

const CORE_FIELDS = [
  ["brand", "marca"], ["model", "modelo"], ["type", "tipo"], ["year", "año"],
  ["km", "km"], ["price", "precio"], ["powerKw", "potencia"], ["cc", "cilindrada"],
  ["location", "ubicación"], ["seller", "vendedor"], ["images", "fotos"], ["description", "descripción"],
];
const HINTS = {
  brand: "pega el texto del anuncio en la página de añadir",
  model: "pega el texto del anuncio en la página de añadir",
  type: "se deduce de marca/modelo; pega el texto si falta",
  year: "pega el texto del anuncio (Año)",
  km: "pega el texto del anuncio (Km)",
  price: "pega el texto del anuncio (precio)",
  powerKw: "potencia: pega el texto o una captura del anuncio",
  cc: "cilindrada: pega el texto del anuncio",
  location: "pega el texto del anuncio (ubicación)",
  seller: "particular o profesional — pega el texto del anuncio",
  images: "sin fotos extraídas — la captura del anuncio ayuda",
  description: "pega la descripción del anuncio en la página de añadir",
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "—" : new Intl.NumberFormat("es-ES").format(n));
const eur = (n) => (n == null ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function utf8ToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- client-side A2 recompute (mirrors scripts/a2.mjs via kb.json) ----------
let KB = null;
async function loadKb() {
  if (KB !== null) return KB;
  try {
    const res = await fetch("kb.json");
    KB = res.ok ? await res.json() : null;
  } catch {
    KB = null;
  }
  return KB;
}
const normModel = (s) => String(s || "").toLowerCase().replace(/[\s-]+/g, "");
function kbMatch(brand, text, kb) {
  const t = normModel(text);
  const m = normModel(brand).slice(0, 4);
  let best = null;
  for (const mod of kb.models || []) {
    const nameNorm = normModel(mod.name);
    if (!nameNorm || !t.includes(nameNorm)) continue;
    if (m && !(mod.make || "").toLowerCase().startsWith(m)) continue;
    if (!best || nameNorm.length > normModel(best.name).length) best = mod;
  }
  return best || null;
}
function quickA2(l, kb) {
  const kw = l.powerKw ?? (l.powerCv ? l.powerCv / 1.36 : null);
  if (kw == null) return null;
  const mm = kb ? kbMatch(l.brand, `${l.model || ""} ${l.title || ""}`, kb) : null;
  const stock = mm?.stockKw ?? null;
  if (kw <= 35) {
    if (stock != null && stock > 70) return { legal: false, restricted: false, confidence: "high", reason: `${mm.make} ${mm.name} derives from ${stock} kW (>70) — cannot be A2 even at 35 kW` };
    if (stock != null && stock > 35) return { legal: true, restricted: true, confidence: stock <= 70 ? "medium" : "high", reason: `Restricted to ${kw} kW from stock ${stock} kW — legal if official A2 version` };
    return { legal: true, restricted: false, confidence: "high", reason: `${kw} kW naturally <= 35 kW` };
  }
  if (stock != null && stock <= 70 && mm.restrictedAvailable) return { legal: false, restricted: false, confidence: "medium", reason: `Listed power ${kw} kW — needs official A2 restriction kit (stock ${stock} kW, kit exists)` };
  return { legal: false, restricted: false, confidence: stock != null ? "high" : "medium", reason: `Power ${kw} kW > 35 kW limit` };
}

async function loadData() {
  if (window.NNEXT) return window.NNEXT; // local dev: app/data.js present
  const token = localStorage.getItem("nnext-token");
  if (!token) return { listings: [], generatedAt: null, needToken: true };
  try {
    const res = await fetch(`${LISTINGS_API}?ref=main`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (res.status === 401 || res.status === 403) return { listings: [], generatedAt: null, badToken: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return { listings: JSON.parse(b64ToUtf8(j.content)), generatedAt: new Date().toISOString() };
  } catch (e) {
    return { listings: [], generatedAt: null, loadError: String(e.message || e) };
  }
}

function showBanner(kind) {
  const old = document.getElementById("setup");
  if (old) old.remove();
  const div = document.createElement("div");
  div.id = "setup";
  div.style.cssText = "margin:8px 22px;padding:14px;border:1px solid #2a3340;border-radius:14px;background:#161b23;font-size:13.5px";
  if (kind === "badToken") {
    div.innerHTML = `<b style="color:#ff6b6b">Token no válido o caducado.</b> Genera uno nuevo (ver guía abajo) y pégalo aquí.<br><input id="tk" type="password" placeholder="github_pat_…" style="margin-top:8px;width:min(420px,100%);padding:8px;border-radius:8px;border:1px solid #2a3340;background:#0e1116;color:#e8edf4"> <button id="saveTk" class="btn" style="margin-top:8px">Guardar</button>`;
  } else if (kind === "loadError") {
    div.innerHTML = `<b style="color:#ffb347">No se pudieron cargar los datos</b>. Comprueba tu conexión o reintenta.`;
  } else {
    div.innerHTML = `<b>Primer uso:</b> crea un token de GitHub y pégalo para ver tus motos.
      <ol style="color:#8b96a5;margin:8px 0 4px 18px;line-height:1.6">
        <li>Abre <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" style="color:#4da3ff">github.com/settings/personal-access-tokens/new</a></li>
        <li>Nombre: <b>nnext-moto</b> · Caducidad: 1 año</li>
        <li>En <i>Repository access</i>: <b>Only select repositories</b> → elige <b>nnext-moto</b></li>
        <li>En <i>Permissions → Repository permissions → Contents</i>: <b>Read and write</b></li>
        <li>Generate → copia el token (empieza por <b>github_pat_</b>) y pégalo aquí</li>
      </ol>
      <input id="tk" type="password" placeholder="github_pat_…" style="width:min(420px,100%);padding:8px;border-radius:8px;border:1px solid #2a3340;background:#0e1116;color:#e8edf4"> <button id="saveTk" class="btn" style="margin-top:6px">Guardar</button>`;
  }
  document.querySelector("header.top").after(div);
  const btn = div.querySelector("#saveTk");
  if (btn) btn.addEventListener("click", () => {
    const v = div.querySelector("#tk").value.trim();
    if (v.length > 20) {
      localStorage.setItem("nnext-token", v);
      location.reload();
    }
  });
}

// ---------- image loading with archive fallback ----------
const imgCache = new Map();

async function archivedImageUrl(l, idx) {
  const f = (l.localImages || [])[idx];
  if (!f) return null;
  const key = `${l.id}/${f}`;
  if (imgCache.has(key)) return imgCache.get(key);
  const token = localStorage.getItem("nnext-token");
  if (!token) return null;
  try {
    const res = await fetch(`${IMG_API}/${l.id}/${f}?ref=main`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" },
    });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    imgCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

function imgTag(l, idx, cls) {
  const remote = (l.images || [])[idx];
  const hasLocal = (l.localImages || []).length > idx;
  const fallback = hasLocal ? `data-local="${idx}"` : "";
  if (!remote && !hasLocal) return `<div class="noimg">sin imagen</div>`;
  if (!remote && hasLocal) return `<img class="${cls || ""}" loading="lazy" ${fallback} data-listing="${l.id}">`;
  return `<img class="${cls || ""}" loading="lazy" src="${esc(remote)}" alt="" ${fallback} data-listing="${l.id}">`;
}

async function handleImgError(el) {
  const l = D.listings.find((x) => x.id === el.dataset.listing);
  if (!l) return;
  const idx = parseInt(el.dataset.local ?? "0", 10);
  const url = await archivedImageUrl(l, idx);
  if (url) { el.src = url; return; }
  el.replaceWith(Object.assign(document.createElement("div"), { className: "noimg", textContent: "sin imagen" }));
}

// ---------- completeness ----------
function completeness(l) {
  let filled = 0;
  const missing = [];
  for (const [key, label] of CORE_FIELDS) {
    const v = l[key];
    const ok = key === "images" ? ((v || []).length > 0 || (l.localImages || []).length > 0)
      : key === "description" ? !!(v && String(v).trim().length > 20)
      : v != null && v !== "";
    if (ok) filled++;
    else missing.push([key, label]);
  }
  return { filled, total: CORE_FIELDS.length, pct: Math.round((filled / CORE_FIELDS.length) * 100), missing };
}

// ---------- comparison ----------
const norm = (s) => String(s || "").toLowerCase().replace(/[\s-]/g, "");

function comparison(l, all) {
  let similar = all.filter((x) => x.id !== l.id && norm(x.model).length > 2 && norm(x.model) === norm(l.model));
  let basis = "mismo modelo";
  if (!similar.length && l.cc) {
    similar = all.filter((x) => x.id !== l.id && x.cc && Math.abs(x.cc - l.cc) / l.cc <= 0.3);
    if (similar.length) basis = `${l.cc} cc ±30%`;
  }
  if (!similar.length && l.type && l.type !== "other") {
    similar = all.filter((x) => x.id !== l.id && x.type === l.type);
    if (similar.length) basis = `tipo ${l.type}`;
  }
  if (!similar.length) return null;

  const act = similar.filter((x) => (x.status || "active") === "active" && x.price != null);
  const prices = act.map((x) => x.price).sort((a, b) => a - b);
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  const medPrice = med(prices);
  const kms = similar.map((x) => x.km).filter((x) => x != null).sort((a, b) => a - b);
  const medKm = med(kms);
  const deltaPct = l.price != null && medPrice ? Math.round(((l.price - medPrice) / medPrice) * 100) : null;

  let verdict = "";
  if (deltaPct == null) verdict = "Precio del anuncio no disponible aún — compara cuando se extraiga.";
  else if (deltaPct <= -5) verdict = `Está un ${Math.abs(deltaPct)}% por debajo de la mediana (${eur(medPrice)}) de ${similar.length} guardadas por ${basis}.`;
  else if (deltaPct >= 5) verdict = `Está un ${deltaPct}% por encima de la mediana (${eur(medPrice)}) de ${similar.length} guardadas por ${basis}.`;
  else verdict = `En línea con la mediana (${eur(medPrice)}) de ${similar.length} guardadas por ${basis}.`;

  return {
    basis,
    count: similar.length,
    similar,
    medPrice,
    medKm,
    deltaPct,
    min: prices.length ? prices[0] : null,
    max: prices.length ? prices[prices.length - 1] : null,
    verdict,
  };
}

// ---------- state ----------
let D = { listings: [], generatedAt: null };
let state = { favOnly: false, sort: "newest" };

const filters = {};

function initFilters() {
  ["f-search", "f-brand", "f-type", "f-status", "f-a2", "f-seller", "f-priceMin", "f-priceMax", "f-kmMax", "f-yearMin", "f-sort"].forEach((id) => {
    filters[id.replace("f-", "")] = $(id);
  });
}

function applyFilters() {
  let rows = D.listings.slice();
  const q = (filters.search?.value || "").toLowerCase().trim();
  if (q) rows = rows.filter((l) => `${l.title || ""} ${l.brand || ""} ${l.model || ""} ${l.location || ""} ${l.description || ""}`.toLowerCase().includes(q));
  if (filters.brand?.value) rows = rows.filter((l) => l.brand === filters.brand.value);
  if (filters.type?.value) rows = rows.filter((l) => (l.type || "other") === filters.type.value);
  if (filters.seller?.value) rows = rows.filter((l) => l.seller === filters.seller.value);
  if (filters.status?.value === "active") rows = rows.filter((l) => (l.status || "active") === "active");
  else if (filters.status?.value === "removed") rows = rows.filter((l) => l.status === "removed");
  if (filters.a2?.value === "yes") rows = rows.filter((l) => l.a2?.legal === true);
  if (filters.a2?.value === "no") rows = rows.filter((l) => l.a2?.legal === false);
  if (filters.a2?.value === "unknown") rows = rows.filter((l) => l.a2?.legal == null);

  const pMin = parseFloat(filters.priceMin?.value);
  const pMax = parseFloat(filters.priceMax?.value);
  if (isFinite(pMin)) rows = rows.filter((l) => l.price != null && l.price >= pMin);
  if (isFinite(pMax)) rows = rows.filter((l) => l.price != null && l.price <= pMax);
  const kmMax = parseFloat(filters.kmMax?.value);
  if (isFinite(kmMax)) rows = rows.filter((l) => l.km != null && l.km <= kmMax);
  const yMin = parseFloat(filters.yearMin?.value);
  if (isFinite(yMin)) rows = rows.filter((l) => l.year != null && l.year >= yMin);
  if (state.favOnly) rows = rows.filter((l) => l.favorite);

  const insMin = (l) => (l.insurance?.min ?? 0);
  const total = (l) => (l.price ?? 0) + insMin(l);
  const pricePerKw = (l) => (l.price && l.powerKw ? l.price / l.powerKw : Infinity);
  switch (state.sort) {
    case "price-asc": rows.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)); break;
    case "price-desc": rows.sort((a, b) => (b.price ?? -1) - (a.price ?? -1)); break;
    case "km-asc": rows.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity)); break;
    case "year-desc": rows.sort((a, b) => (b.year ?? -1) - (a.year ?? -1)); break;
    case "total-asc": rows.sort((a, b) => total(a) - total(b)); break;
    case "price-kw": rows.sort((a, b) => pricePerKw(a) - pricePerKw(b)); break;
    default: rows.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  }
  return rows;
}

// ---------- cards ----------
function statusBadge(l) {
  const s = l.status || "active";
  if (s === "removed") return `<span class="badge status">vendida/eliminada</span>`;
  if (l.availability === "reserved") return `<span class="badge status" title="El anuncio está marcado como reservado en el sitio original">reservada</span>`;
  if (l.availability === "sold") return `<span class="badge status">vendida</span>`;
  if (l.scrapeStatus === "needs-manual" || l.scrapeStatus === "blocked") return `<span class="badge status">datos incompletos</span>`;
  return "";
}
function a2Badge(l) {
  const a = l.a2 || {};
  if (a.legal === true) return `<span class="badge a2-yes" title="${esc(a.reason || "")}">A2 ${a.restricted ? "(restricción)" : "legal"}</span>`;
  if (a.legal === false) return `<span class="badge a2-no" title="${esc(a.reason || "")}">No A2</span>`;
  return `<span class="badge a2-unknown" title="${esc(a.reason || "Sin datos de potencia")}">A2 ?</span>`;
}
function priceDelta(l) {
  const h = l.priceHistory || [];
  if (h.length < 2) return "";
  const prev = h[h.length - 2].price, cur = h[h.length - 1].price;
  if (prev == null || cur == null || prev === cur) return "";
  const pct = Math.round(((cur - prev) / prev) * 100);
  return pct < 0 ? `<span class="price-drop">▼ ${Math.abs(pct)}%</span>` : `<span class="price-rise">▲ ${pct}%</span>`;
}
function historyText(l) {
  const h = l.priceHistory || [];
  if (h.length < 2) return "";
  return `historial: ${h.map((p) => eur(p.price)).join(" → ")}`;
}

function card(l) {
  const c = completeness(l);
  const total = l.price != null && l.insurance?.min != null ? l.price + l.insurance.min : null;
  const nImgs = (l.images || []).length + Math.max(0, (l.localImages || []).length - (l.images || []).length);
  const thumbs = [0, 1, 2, 3].map((i) => (nImgs > i ? imgTag(l, i, "thumb-strip-img") : "")).join("");
  return `<article class="card ${l.status === "removed" ? "removed" : ""}" data-id="${l.id}">
    <div class="thumb" data-open="${l.id}">
      ${imgTag(l, 0, "thumb-main")}
      <div class="badges">${a2Badge(l)}${statusBadge(l)}${l.favorite ? `<span class="badge fav">favorita</span>` : ""}<span class="badge comp" title="datos completos">${c.pct}%</span></div>
      <button class="favbtn ${l.favorite ? "on" : ""}" title="Favorita">★</button>
    </div>
    <div class="body">
      <h3><a href="#/moto/${l.id}" class="detail-link">${esc(l.title || `${l.brand || ""} ${l.model || ""}`.trim() || "Sin título")}</a></h3>
      <div class="meta">
        ${l.brand ? `<span><b>${esc(l.brand)}</b></span>` : ""}
        ${l.model ? `<span>${esc(l.model)}</span>` : ""}
        ${l.year ? `<span>${l.year}</span>` : ""}
        ${l.km != null ? `<span><b>${fmt(l.km)}</b> km</span>` : ""}
        ${l.powerKw != null ? `<span>${l.powerKw} kW${l.powerCv ? " · " + l.powerCv + " CV" : ""}</span>` : ""}
        ${l.cc ? `<span>${l.cc} cc</span>` : ""}
        ${l.location ? `<span>${esc(l.location)}</span>` : ""}
        ${l.seller ? `<span>${l.seller === "particular" ? "particular" : "pro"}</span>` : ""}
      </div>
      <div class="a2-reason">${esc(l.a2?.reason || "")}</div>
      <div class="thumb-strip" data-open="${l.id}">${thumbs}</div>
      <div class="prices">
        <span class="price">${eur(l.price)}</span>
        ${priceDelta(l)}
      </div>
      <div class="chips">
        ${l.insurance ? `<span class="chip ins" title="Estimación anual terceros+grúa para tu perfil">seguro ${l.insurance.min}–${l.insurance.max} €/año</span>` : ""}
        ${total != null ? `<span class="chip total" title="Precio + seguro estimado año 1">total 1er año ${eur(total)}</span>` : ""}
        <span class="chip site">${esc(l.site || "")}</span>
      </div>
      <div class="history">${historyText(l)}</div>
    </div>
  </article>`;
}

function render() {
  const rows = applyFilters();
  $("grid").innerHTML = rows.map(card).join("");
  $("empty").classList.toggle("hidden", rows.length > 0);

  const active = D.listings.filter((l) => (l.status || "active") === "active");
  const prices = active.map((l) => l.price).filter((p) => p != null).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const a2ok = active.filter((l) => l.a2?.legal === true).length;
  $("stats").innerHTML = `
    <div class="stat"><b>${D.listings.length}</b><span>motos guardadas</span></div>
    <div class="stat"><b>${active.length}</b><span>activas ahora</span></div>
    <div class="stat"><b>${a2ok}</b><span>A2 legales</span></div>
    <div class="stat"><b>${eur(median)}</b><span>precio mediano</span></div>
    ${prices.length ? `<div class="stat"><b>${eur(prices[0])} – ${eur(prices[prices.length - 1])}</b><span>rango de precios</span></div>` : ""}
  `;
  $("generated").textContent = D.generatedAt ? `actualizado ${new Date(D.generatedAt).toLocaleString("es-ES")}` : "";

  $("grid").querySelectorAll(".favbtn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.closest(".card").dataset.id;
      const l = D.listings.find((x) => x.id === id);
      if (!l) return;
      l.favorite = !l.favorite;
      const favs = JSON.parse(localStorage.getItem("nnext-favs") || "{}");
      favs[id] = l.favorite;
      localStorage.setItem("nnext-favs", JSON.stringify(favs));
      render();
    });
  });
  // image error fallbacks + eager load of local-only (archived) images
  document.querySelectorAll("img[data-listing]").forEach((el) => {
    el.addEventListener("error", () => handleImgError(el), { once: true });
    if (el.dataset.local != null && !el.getAttribute("src")) handleImgError(el);
  });
  // open detail on card/thumbs click
  document.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => { location.hash = `#/moto/${el.dataset.open}`; });
  });
}

// ---------- detail view ----------
function specsGrid(l) {
  const rows = [
    ["Marca", l.brand], ["Modelo", l.model], ["Tipo", l.type], ["Año", l.year],
    ["Km", l.km != null ? fmt(l.km) : null], ["Precio", l.price != null ? eur(l.price) : null],
    ["Potencia", l.powerKw != null ? `${l.powerKw} kW${l.powerCv ? " (" + l.powerCv + " CV)" : ""}` : null],
    ["Cilindrada", l.cc ? `${l.cc} cc` : null], ["Color", l.color], ["Cambio", l.gearbox],
    ["Combustible", l.fuel], ["Estado", l.condition], ["Carnet", l.carnet],
    ["Ubicación", l.location ? `${l.location}${l.postalCode ? " (" + l.postalCode + ")" : ""}` : null],
    ["Vendedor", l.seller], ["Sitio", l.site],
    ["Añadida", l.addedAt ? new Date(l.addedAt).toLocaleDateString("es-ES") : null],
    ["Última copia", l.lastScrapedAt ? new Date(l.lastScrapedAt).toLocaleString("es-ES") : null],
    ["Estado anuncio", l.status === "removed" ? "vendida/eliminada (datos conservados)" : l.availability === "reserved" ? "reservada en el sitio original" : l.availability === "sold" ? "vendida" : "activa"],
  ];
  return rows.map(([k, v]) => `<div class="spec ${v == null ? "spec-miss" : ""}"><span>${k}</span><b>${v == null ? "—" : esc(v)}</b></div>`).join("");
}

function galleryHtml(l) {
  const n = Math.max((l.images || []).length, (l.localImages || []).length);
  if (!n) return `<div class="noimg big">sin imágenes</div>`;
  return `<div class="gal-main" id="galMain">${imgTag(l, 0, "gal-img")}</div>
    <div class="gal-thumbs">${Array.from({ length: Math.min(n, 12) }, (_, i) => `<div class="gal-thumb ${i === 0 ? "on" : ""}" data-gal="${i}">${imgTag(l, i, "")}</div>`).join("")}</div>`;
}

function comparisonHtml(l, c) {
  if (!c) return `<p class="muted">Aún no hay motos similares guardadas para comparar. Añade más enlaces y aparecerá el análisis.</p>`;
  const bar = (pct) => {
    const w = Math.min(Math.abs(pct), 40) * 2.2;
    return `<div class="cmp-bar"><div class="cmp-fill ${pct <= 0 ? "under" : "over"}" style="width:${w}%"></div></div>`;
  };
  return `
    <div class="cmp-verdict">${esc(c.verdict)}</div>
    ${c.deltaPct != null ? bar(c.deltaPct) : ""}
    <div class="cmp-stats">
      <div class="spec"><span>Mediana precio (${esc(c.basis)})</span><b>${eur(c.medPrice)}</b></div>
      <div class="spec"><span>Rango guardadas</span><b>${eur(c.min)} – ${eur(c.max)}</b></div>
      <div class="spec"><span>Km mediana</span><b>${c.medKm != null ? fmt(c.medKm) : "—"}</b></div>
      ${c.medKm != null && l.km != null ? `<div class="spec"><span>Tus km vs mediana</span><b>${l.km > c.medKm ? "+" : ""}${fmt(l.km - c.medKm)} km</b></div>` : ""}
      <div class="spec"><span>Similares guardadas</span><b>${c.count}</b></div>
    </div>
    <div class="cmp-list">${c.similar.map((x) => `<a class="cmp-item" href="#/moto/${x.id}">${esc(x.brand || "")} ${esc(x.model || "")} · ${eur(x.price)} · ${x.km != null ? fmt(x.km) + " km" : "—"} · ${x.year ?? "?"} · ${x.site}</a>`).join("")}</div>`;
}

function openDetail(id) {
  const l = D.listings.find((x) => x.id === id);
  if (!l) return;
  const c = completeness(l);
  const cmp = comparison(l, D.listings);
  const notes = (JSON.parse(localStorage.getItem("nnext-notes") || "{}"))[id] || "";
  const overlay = document.createElement("div");
  overlay.id = "detail";
  overlay.innerHTML = `
    <div class="detail-card">
      <div class="detail-head">
        <button class="btn ghost" id="detailClose">← Volver</button>
        <h2>${esc(l.title || `${l.brand || ""} ${l.model || ""}`)}</h2>
        <button class="btn" id="editToggle">Editar ficha</button>
        <a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">Ver anuncio ↗</a>
      </div>
      <div class="detail-grid">
        <div class="detail-col">
          ${galleryHtml(l)}
          <div class="prices detail-prices">
            <span class="price">${eur(l.price)}</span>
            ${priceDelta(l)}
            ${l.insurance ? `<span class="chip ins">seguro est. ${l.insurance.min}–${l.insurance.max} €/año</span>` : ""}
            ${l.price != null && l.insurance ? `<span class="chip total">total 1er año ${eur(l.price + l.insurance.min)}</span>` : ""}
          </div>
          <div class="badges-detail">${a2Badge(l)}${statusBadge(l)}</div>
          <div class="a2-reason">${esc(l.a2?.reason || "")}</div>
          <h3>Descripción</h3>
          <div class="desc">${l.description ? esc(l.description).replace(/\n/g, "<br>") : '<span class="muted">No hay descripción guardada.</span>'}</div>
          <h3>Notas (privadas, en este dispositivo)</h3>
          <textarea id="detailNotes" placeholder="Ej: llamada hecha, preguntar por el kit A2…">${esc(notes)}</textarea>
        </div>
        <div class="detail-col">
          ${editPanelHtml(l)}
          <h3>Ficha <span class="muted">${c.filled}/${c.total} datos · ${c.pct}%</span></h3>
          <div class="specs">${specsGrid(l)}</div>
          ${c.missing.length ? `<h3>Falta información</h3><div class="chips">${c.missing.map(([k, label]) => `<span class="chip miss" title="${esc(HINTS[k] || "")}">${esc(label)}</span>`).join("")}</div><p class="muted">Pasa el ratón (o mantén pulsado) sobre cada dato para ver cómo completarlo.</p>` : ""}
          <h3>Historial de precio</h3>
          <div class="history-detail">${(l.priceHistory || []).map((p) => `<div class="hrow"><span>${p.date}</span><b>${eur(p.price)}</b></div>`).join("") || '<span class="muted">Sin cambios registrados aún.</span>'}</div>
          <h3>Comparación con tu mercado</h3>
          ${comparisonHtml(l, cmp)}
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  $("detailClose").addEventListener("click", () => { location.hash = ""; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) location.hash = ""; });
  // edit panel
  $("editToggle").addEventListener("click", () => {
    $("editPanel").classList.toggle("hidden");
    $("editToggle").textContent = $("editPanel").classList.contains("hidden") ? "Editar ficha" : "Cerrar edición";
  });
  $("editCancel").addEventListener("click", () => refreshDetail(id));
  $("editSave").addEventListener("click", async () => {
    const status = $("editStatus");
    // interpret user-typed numbers: "34,6" and "34.6" = 34.6; "5.250" = 5250
    function parseUserNumber(s) {
      const t = String(s).trim().replace(/\s/g, "");
      if (!/^\d[\d.,]*$/.test(t)) return NaN;
      const sep = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
      if (sep === -1) return Number(t.replace(/[.,]/g, ""));
      const dec = t.length - sep - 1;
      const digits = t.replace(/[.,]/g, "");
      if (dec === 3) return Number(digits); // "5.250" thousands
      if (dec >= 1 && dec <= 2) return Number(digits.slice(0, -dec) + "." + digits.slice(-dec)); // "34,6" decimal
      return Number(digits);
    }
    const patch = {};
    document.querySelectorAll("#editPanel [data-edit]").forEach((el) => {
      const k = el.dataset.edit;
      let v = el.value;
      if (el.type === "number" && v !== "") {
        const n = parseUserNumber(v);
        v = Number.isFinite(n) ? n : v;
      }
      if (String(l[k] ?? "") !== String(v) && !(l[k] == null && v === "")) patch[k] = v;
    });
    if (!Object.keys(patch).length) { status.textContent = "sin cambios"; return; }
    status.textContent = "guardando…";
    try {
      const listings = await saveListingEdits(id, patch);
      Object.assign(D.listings.find((x) => x.id === id), listings.find((x) => x.id === id));
      await loadKb();
      const l2 = D.listings.find((x) => x.id === id);
      const qa = quickA2(l2, KB);
      if (qa) l2.a2 = qa;
      refreshDetail(id);
    } catch (e) {
      status.textContent = e.message;
      status.style.color = "#ff6b6b";
    }
  });
  const notesEl = $("detailNotes");
  notesEl.addEventListener("input", () => {
    const notes = JSON.parse(localStorage.getItem("nnext-notes") || "{}");
    notes[id] = notesEl.value;
    localStorage.setItem("nnext-notes", JSON.stringify(notes));
  });
  // gallery interactions
  const galMain = $("galMain");
  overlay.querySelectorAll("[data-gal]").forEach((t) => {
    t.addEventListener("click", () => {
      overlay.querySelectorAll("[data-gal]").forEach((x) => x.classList.remove("on"));
      t.classList.add("on");
      const idx = parseInt(t.dataset.gal, 10);
      const remote = (l.images || [])[idx];
      const hasLocal = (l.localImages || []).length > idx;
      galMain.innerHTML = `<img class="gal-img" src="${esc(remote || "")}" alt="" ${hasLocal ? `data-local="${idx}"` : ""} data-listing="${l.id}">`;
      const img = galMain.querySelector("img");
      img.addEventListener("error", () => handleImgError(img), { once: true });
      if (img.dataset.local != null && !img.getAttribute("src")) handleImgError(img);
    });
  });
  const mainImg = galMain.querySelector("img");
  if (mainImg) mainImg.addEventListener("error", () => handleImgError(mainImg), { once: true });
  galMain.addEventListener("click", () => {
    const img = galMain.querySelector("img");
    if (img && img.src) window.open(img.src, "_blank");
  });
}

function closeDetail() {
  const d = $("detail");
  if (d) d.remove();
  document.body.style.overflow = "";
}

function route() {
  const m = location.hash.match(/#\/moto\/([0-9a-f]+)/);
  if (m) openDetail(m[1]);
  else closeDetail();
}

// ---------- editing from the dashboard ----------
const EDIT_FIELDS = [
  ["title", "Título", "text"],
  ["brand", "Marca", "text"],
  ["model", "Modelo", "text"],
  ["type", "Tipo", "select", ["other", "scooter", "trail", "custom", "sport", "classic", "touring", "naked", "enduro"]],
  ["year", "Año", "number"],
  ["km", "Km", "number"],
  ["price", "Precio €", "number"],
  ["powerKw", "Potencia kW", "number"],
  ["powerCv", "Potencia CV", "number"],
  ["cc", "Cilindrada cc", "number"],
  ["location", "Ubicación", "text"],
  ["seller", "Vendedor", "select", ["particular", "profesional"]],
  ["fuel", "Combustible", "text"],
  ["gearbox", "Cambio", "text"],
  ["color", "Color", "text"],
  ["condition", "Estado", "text"],
  ["carnet", "Carnet", "text"],
];

function editPanelHtml(l) {
  const rows = EDIT_FIELDS.map(([k, label, kind, opts]) => {
    const v = l[k] ?? "";
    if (kind === "select") {
      return `<label class="edit-field"><span>${label}</span><select data-edit="${k}">${opts.map((o) => `<option value="${o}" ${String(v) === o ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
    }
    return `<label class="edit-field"><span>${label}</span><input data-edit="${k}" type="${kind}" value="${esc(v)}"></label>`;
  }).join("");
  return `<div class="edit-panel hidden" id="editPanel">
    <div class="edit-grid">${rows}</div>
    <div class="edit-actions">
      <button class="btn" id="editCancel">Cancelar</button>
      <button class="btn primary" id="editSave">Guardar cambios</button>
      <span class="muted" id="editStatus"></span>
    </div>
    <p class="muted">Lo que guardes aquí queda protegido: los refrescos automáticos no sobrescriben estos campos. El veredicto A2 se recalcula al instante; el seguro estimado se actualiza en el próximo refresco automático.</p>
  </div>`;
}

async function saveListingEdits(id, patch) {
  const token = localStorage.getItem("nnext-token");
  if (!token) throw new Error("sin token — vuelve a la página de añadir para configurarlo");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${LISTINGS_API}?ref=main`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (res.status === 401 || res.status === 403) throw new Error("token no válido o sin permiso de escritura");
    if (!res.ok) throw new Error(`no se pudo leer listings.json (HTTP ${res.status})`);
    const j = await res.json();
    const listings = JSON.parse(b64ToUtf8(j.content));
    const rec = listings.find((x) => x.id === id);
    if (!rec) throw new Error("listado no encontrado en listings.json");
    for (const [k, v] of Object.entries(patch)) {
      rec[k] = v === "" ? null : v;
      if (v !== "" && v != null) {
        rec.manualFields = [...new Set([...(rec.manualFields || []), k])];
        rec.userFields = [...new Set([...(rec.userFields || []), k])];
      } else {
        rec.manualFields = (rec.manualFields || []).filter((f) => f !== k);
        rec.userFields = (rec.userFields || []).filter((f) => f !== k);
      }
    }
    const put = await fetch(LISTINGS_API, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `edit ${id} from dashboard`,
        content: utf8ToB64(JSON.stringify(listings, null, 2) + "\n"),
        sha: j.sha,
        branch: "main",
      }),
    });
    if (put.ok) return listings;
    if (put.status === 409 || put.status === 422) continue; // bot committed meanwhile — refetch & retry
    const err = await put.json().catch(() => ({}));
    throw new Error(`GitHub rechazó el guardado (HTTP ${put.status}) ${err.message || ""}`);
  }
  throw new Error("conflicto con el refresco automático — reintenta en unos segundos");
}

function refreshDetail(id) {
  closeDetail();
  if (location.hash === `#/moto/${id}`) openDetail(id);
  else location.hash = `#/moto/${id}`;
  render();
}

// ---------- exports ----------
function tableRows() {
  return D.listings.map((l) => ({
    id: l.id, marca: l.brand, modelo: l.model, tipo: l.type, año: l.year,
    km: l.km, precio: l.price, kW: l.powerKw, CV: l.powerCv, cc: l.cc,
    A2: l.a2?.legal === true ? "sí" : l.a2?.legal === false ? "no" : "?",
    "motivo A2": l.a2?.reason,
    "seguro min €": l.insurance?.min, "seguro max €": l.insurance?.max,
    estado: l.status, ubicación: l.location, vendedor: l.seller,
    fotos: (l.images || []).length,
    "desc guardada": l.description ? "sí" : "no",
    añadida: l.addedAt, última_copia: l.lastScrapedAt, título: l.title, url: l.url,
  }));
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function wireExports() {
  $("exportCsv").addEventListener("click", () => {
    const rows = tableRows();
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const csv = "\ufeff" + cols.join(";") + "\n" + rows.map((r) => cols.map((c) => {
      const v = r[c] == null ? "" : String(r[c]);
      return /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(";")).join("\n");
    download(new Blob([csv], { type: "text/csv;charset=utf-8" }), "nnext-moto.csv");
  });
  $("exportXlsx").addEventListener("click", () => {
    if (!window.XLSX) { $("exportCsv").click(); return; }
    const ws = window.XLSX.utils.json_to_sheet(tableRows());
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "motos");
    const out = window.XLSX.write(wb, { bookType: "xlsx", type: "array" });
    download(new Blob([out], { type: "application/octet-stream" }), "nnext-moto.xlsx");
  });
}

// ---------- main ----------
(async () => {
  D = await loadData();
  if (D.needToken) showBanner("needToken");
  else if (D.badToken) showBanner("badToken");
  else if (D.loadError) showBanner("loadError");

  // restore favorites
  const favs = JSON.parse(localStorage.getItem("nnext-favs") || "{}");
  for (const l of D.listings) if (l.id in favs) l.favorite = !!favs[l.id];

  initFilters();
  const brands = [...new Set(D.listings.map((l) => l.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const b of brands) {
    const o = document.createElement("option");
    o.textContent = b;
    filters.brand.appendChild(o);
  }
  for (const [k, f] of Object.entries(filters)) {
    if (k === "sort") f.addEventListener("change", () => { state.sort = f.value; render(); });
    else { f.addEventListener("input", render); f.addEventListener("change", render); }
  }
  $("f-fav").addEventListener("click", () => {
    state.favOnly = !state.favOnly;
    $("f-fav").classList.toggle("on", state.favOnly);
    render();
  });
  $("f-reset").addEventListener("click", () => {
    for (const f of Object.values(filters)) f.value = "";
    filters.status.value = "active";
    state.favOnly = false;
    $("f-fav").classList.remove("on");
    render();
  });
  wireExports();
  window.addEventListener("hashchange", route);
  render();
  route();
})();

document.addEventListener("click", (e) => {
  if (e.target?.id !== "manageToken") return;
  const t = localStorage.getItem("nnext-token");
  if (t) {
    if (confirm("¿Borrar el token guardado en este dispositivo?")) {
      localStorage.removeItem("nnext-token");
      location.reload();
    }
  } else {
    localStorage.removeItem("nnext-token");
    location.reload();
  }
});
