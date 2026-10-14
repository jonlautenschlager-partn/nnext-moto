const OWNER = "jonlautenschlager-partn";
const REPO = "nnext-moto";
const LISTINGS_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/data/listings.json`;

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
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
    div.innerHTML = `<b style="color:#ffb347">No se pudieron cargar los datos</b> (${kind}). Comprueba tu conexión o reintenta.`;
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

(async () => {
  const D = await loadData();
  if (D.needToken) showBanner("needToken");
  else if (D.badToken) showBanner("badToken");
  else if (D.loadError) showBanner("loadError");
  const el = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? "—" : new Intl.NumberFormat("es-ES").format(n));
  const eur = (n) => (n == null ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n));

  let state = {
    favOnly: false,
    sort: "newest",
  };

  const filters = {
    search: el("f-search"),
    brand: el("f-brand"),
    type: el("f-type"),
    status: el("f-status"),
    a2: el("f-a2"),
    seller: el("f-seller"),
    priceMin: el("f-priceMin"),
    priceMax: el("f-priceMax"),
    kmMax: el("f-kmMax"),
    yearMin: el("f-yearMin"),
    sort: el("f-sort"),
  };

  // populate brand options
  const brands = [...new Set(D.listings.map((l) => l.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const b of brands) {
    const o = document.createElement("option");
    o.textContent = b;
    filters.brand.appendChild(o);
  }

  function apply() {
    let rows = D.listings.slice();

    const q = (filters.search.value || "").toLowerCase().trim();
    if (q) rows = rows.filter((l) => `${l.title || ""} ${l.brand || ""} ${l.model || ""} ${l.location || ""} ${l.description || ""}`.toLowerCase().includes(q));
    if (filters.brand.value) rows = rows.filter((l) => l.brand === filters.brand.value);
    if (filters.type.value) rows = rows.filter((l) => (l.type || "other") === filters.type.value);
    if (filters.seller.value) rows = rows.filter((l) => l.seller === filters.seller.value);
    if (filters.status.value === "active") rows = rows.filter((l) => (l.status || "active") === "active");
    else if (filters.status.value === "removed") rows = rows.filter((l) => l.status === "removed");
    if (filters.a2.value === "yes") rows = rows.filter((l) => l.a2?.legal === true);
    if (filters.a2.value === "no") rows = rows.filter((l) => l.a2?.legal === false);
    if (filters.a2.value === "unknown") rows = rows.filter((l) => l.a2?.legal == null);

    const pMin = parseFloat(filters.priceMin.value);
    const pMax = parseFloat(filters.priceMax.value);
    if (isFinite(pMin)) rows = rows.filter((l) => l.price != null && l.price >= pMin);
    if (isFinite(pMax)) rows = rows.filter((l) => l.price != null && l.price <= pMax);
    const kmMax = parseFloat(filters.kmMax.value);
    if (isFinite(kmMax)) rows = rows.filter((l) => l.km != null && l.km <= kmMax);
    const yMin = parseFloat(filters.yearMin.value);
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

  function statusBadge(l) {
    const s = l.status || "active";
    if (s === "removed") return `<span class="badge status">vendida/eliminada</span>`;
    if (l.scrapeStatus === "needs-manual" || l.scrapeStatus === "blocked") return `<span class="badge status">datos incompletos</span>`;
    return "";
  }

  function a2Badge(l) {
    const a = l.a2 || {};
    if (a.legal === true) return `<span class="badge a2-yes" title="${a.reason || ""}">A2 ${a.restricted ? "(restricción)" : "legal"}</span>`;
    if (a.legal === false) return `<span class="badge a2-no" title="${a.reason || ""}">No A2</span>`;
    return `<span class="badge a2-unknown" title="${a.reason || "Sin datos de potencia"}">A2 ?</span>`;
  }

  function priceDelta(l) {
    const h = l.priceHistory || [];
    if (h.length < 2) return "";
    const prev = h[h.length - 2].price, cur = h[h.length - 1].price;
    if (prev == null || cur == null || prev === cur) return "";
    const pct = Math.round(((cur - prev) / prev) * 100);
    return pct < 0
      ? `<span class="price-drop">▼ ${Math.abs(pct)}% vs anterior</span>`
      : `<span class="price-rise">▲ ${pct}% vs anterior</span>`;
  }

  function historyText(l) {
    const h = l.priceHistory || [];
    if (h.length < 2) return "";
    return `historial: ${h.map((p) => eur(p.price)).join(" → ")}`;
  }

  function card(l) {
    const img = l.images?.[0];
    const total = l.price != null && l.insurance?.min != null ? l.price + l.insurance.min : null;
    return `<article class="card ${l.status === "removed" ? "removed" : ""}" data-id="${l.id}">
      <div class="thumb">
        ${img ? `<img loading="lazy" src="${img}" alt="" onerror="this.parentNode.innerHTML='<div class=noimg>sin imagen</div>'">` : `<div class="noimg">sin imagen</div>`}
        <div class="badges">${a2Badge(l)}${statusBadge(l)}${l.favorite ? `<span class="badge fav">favorita</span>` : ""}</div>
        <button class="favbtn ${l.favorite ? "on" : ""}" title="Favorita">★</button>
      </div>
      <div class="body">
        <h3><a href="${l.url}" target="_blank" rel="noopener">${l.title || `${l.brand || ""} ${l.model || ""}`.trim() || "Sin título"}</a></h3>
        <div class="meta">
          ${l.brand ? `<span><b>${l.brand}</b></span>` : ""}
          ${l.model ? `<span>${l.model}</span>` : ""}
          ${l.year ? `<span>${l.year}</span>` : ""}
          ${l.km != null ? `<span><b>${fmt(l.km)}</b> km</span>` : ""}
          ${l.powerKw != null ? `<span>${l.powerKw} kW${l.powerCv ? " · " + l.powerCv + " CV" : ""}</span>` : ""}
          ${l.cc ? `<span>${l.cc} cc</span>` : ""}
          ${l.location ? `<span>${l.location}</span>` : ""}
          ${l.seller ? `<span>${l.seller === "particular" ? "particular" : "pro"}</span>` : ""}
        </div>
        <div class="a2-reason">${l.a2?.reason || ""}</div>
        <div class="prices">
          <span class="price">${eur(l.price)}</span>
          ${priceDelta(l)}
        </div>
        <div class="chips">
          ${l.insurance ? `<span class="chip ins" title="Estimación anual terceros+grúa para tu perfil">seguro ${l.insurance.min}–${l.insurance.max} €/año</span>` : ""}
          ${total != null ? `<span class="chip total" title="Precio + seguro estimado año 1">total 1er año ${eur(total)}</span>` : ""}
          <span class="chip site">${l.site || ""}</span>
        </div>
        <div class="history">${historyText(l)}</div>
      </div>
    </article>`;
  }

  function render() {
    const rows = apply();
    el("grid").innerHTML = rows.map(card).join("");
    el("empty").classList.toggle("hidden", rows.length > 0);

    // stats
    const active = D.listings.filter((l) => (l.status || "active") === "active");
    const prices = active.map((l) => l.price).filter((p) => p != null).sort((a, b) => a - b);
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
    const a2ok = active.filter((l) => l.a2?.legal === true).length;
    el("stats").innerHTML = `
      <div class="stat"><b>${D.listings.length}</b><span>motos guardadas</span></div>
      <div class="stat"><b>${active.length}</b><span>activas ahora</span></div>
      <div class="stat"><b>${a2ok}</b><span>A2 legales</span></div>
      <div class="stat"><b>${eur(median)}</b><span>precio mediano</span></div>
      ${prices.length ? `<div class="stat"><b>${eur(prices[0])} – ${eur(prices[prices.length - 1])}</b><span>rango de precios</span></div>` : ""}
    `;
    el("generated").textContent = D.generatedAt ? `actualizado ${new Date(D.generatedAt).toLocaleString("es-ES")}` : "";

    // favorites
    el("grid").querySelectorAll(".favbtn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const id = btn.closest(".card").dataset.id;
        const l = D.listings.find((x) => x.id === id);
        if (!l) return;
        l.favorite = !l.favorite;
        // persist to localStorage; sync on next scrape via exported favorites
        const favs = JSON.parse(localStorage.getItem("nnext-favs") || "{}");
        favs[id] = l.favorite;
        localStorage.setItem("nnext-favs", JSON.stringify(favs));
        render();
      });
    });
  }

  // restore favorites from localStorage
  const favs = JSON.parse(localStorage.getItem("nnext-favs") || "{}");
  for (const l of D.listings) if (l.id in favs) l.favorite = !!favs[l.id];

  for (const [k, f] of Object.entries(filters)) {
    if (k === "sort") f.addEventListener("change", () => { state.sort = f.value; render(); });
    else f.addEventListener("input", render);
    f.addEventListener("change", render);
  }
  el("f-fav").addEventListener("click", () => {
    state.favOnly = !state.favOnly;
    el("f-fav").classList.toggle("on", state.favOnly);
    render();
  });
  el("f-reset").addEventListener("click", () => {
    for (const f of Object.values(filters)) f.value = "";
    filters.status.value = "active";
    state.favOnly = false;
    el("f-fav").classList.remove("on");
    render();
  });

  // exports
  function tableRows() {
    return D.listings.map((l) => ({
      id: l.id, marca: l.brand, modelo: l.model, tipo: l.type, año: l.year,
      km: l.km, precio: l.price, kW: l.powerKw, CV: l.powerCv, cc: l.cc,
      A2: l.a2?.legal === true ? "sí" : l.a2?.legal === false ? "no" : "?",
      "motivo A2": l.a2?.reason,
      "seguro min €": l.insurance?.min, "seguro max €": l.insurance?.max,
      estado: l.status, ubicación: l.location, vendedor: l.seller,
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
  el("exportCsv").addEventListener("click", () => {
    const rows = tableRows();
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const csv = "\ufeff" + cols.join(";") + "\n" + rows.map((r) => cols.map((c) => {
      const v = r[c] == null ? "" : String(r[c]);
      return /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(";")).join("\n");
    download(new Blob([csv], { type: "text/csv;charset=utf-8" }), "nnext-moto.csv");
  });
  el("exportXlsx").addEventListener("click", () => {
    if (!window.XLSX) { el("exportCsv").click(); return; }
    const ws = window.XLSX.utils.json_to_sheet(tableRows());
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "motos");
    const out = window.XLSX.write(wb, { bookType: "xlsx", type: "array" });
    download(new Blob([out], { type: "application/octet-stream" }), "nnext-moto.xlsx");
  });

  render();
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
