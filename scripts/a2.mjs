import { readJson, KB_DIR, parseEsNumber } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadKbSync() {
  try {
    return JSON.parse(readFileSync(join(KB_DIR, "models.json"), "utf8")).models || [];
  } catch {
    return [];
  }
}

// Normalize model name: "Yamaha MT-07 A2 2021" -> { make: "Yamaha", name: "MT-07" }
export function matchModel(make, title) {
  const models = loadKbSync();
  const t = (title || "").toLowerCase();
  const m = (make || "").toLowerCase();
  let best = null;
  for (const mod of models) {
    const nameLower = mod.name.toLowerCase();
    if (!t.includes(nameLower)) continue;
    if (m && !mod.make.toLowerCase().startsWith(m.slice(0, 4))) continue;
    if (!best || nameLower.length > best.name.toLowerCase().length) best = mod;
  }
  return best || null;
}

// A2 rules (Spain): <= 35 kW, <= 0.2 kW/kg, and if restricted, derived model <= 70 kW
export async function a2Check(listing) {
  const kw = listing.powerKw ?? (listing.powerCv ? listing.powerCv / 1.36 : null);
  const kg = listing.weightKg ?? null;

  const result = {
    legal: null,
    restricted: false,
    confidence: "low",
    reason: "",
  };

  if (kw == null) {
    // try to match model from title for KB power
    const mm = matchModel(listing.brand, listing.title);
    if (mm) {
      result.reason = `No power in listing; matched KB model ${mm.make} ${mm.name}`;
    } else {
      result.reason = "No power info and no model match";
      return result;
    }
  }

  let powerKw = kw;
  const mm = matchModel(listing.brand, listing.title + " " + (listing.model || ""));
  let stockKw = mm ? mm.stockKw : null;

  if (powerKw == null && stockKw != null) {
    // listing has no power; if stock <= 35 it's naturally legal
    if (stockKw <= 35) {
      result.legal = true;
      result.confidence = "high";
      result.reason = `Stock model ${mm.name} is ${stockKw} kW (naturally A2)`;
      return result;
    }
    if (mm.restrictedAvailable) {
      result.legal = true;
      result.restricted = true;
      result.confidence = "medium";
      result.reason = `Assume A2-restricted version of ${mm.name} (stock ${stockKw} kW) — confirm "35 kW" in ad`;
      return result;
    }
    result.legal = false;
    result.confidence = "medium";
    result.reason = `Model ${mm.name} has no A2 version (stock ${stockKw} kW > 35)`;
    return result;
  }

  // We have a stated power (possibly restricted)
  if (powerKw <= 35) {
    if (stockKw != null && stockKw > 70) {
      result.legal = false;
      result.confidence = "high";
      result.reason = `${mm.make} ${mm.name} derives from ${stockKw} kW (>70) — cannot be A2 even at 35 kW`;
      return result;
    }
    if (stockKw != null && stockKw > 35) {
      result.legal = true;
      result.restricted = true;
      result.confidence = stockKw <= 70 ? "medium" : "high";
      result.reason = `Restricted to ${powerKw} kW from stock ${stockKw} kW — legal if official A2 version`;
      return result;
    }
    result.legal = true;
    result.confidence = "high";
    result.reason = `${powerKw} kW naturally <= 35 kW`;
    return result;
  }

  // power > 35 kW stated: maybe CC mismatch or fake; check if restrictable
  if (stockKw != null && stockKw <= 70 && mm.restrictedAvailable) {
    result.legal = false;
    result.reason = `Listed power ${powerKw} kW — needs official A2 restriction kit (stock ${stockKw} kW, kit exists)`;
    return result;
  }
  result.legal = false;
  result.confidence = stockKw != null ? "high" : "medium";
  result.reason = `Power ${powerKw} kW > 35 kW limit`;

  // power-to-weight
  if (result.legal && kg && powerKw / kg > 0.2) {
    result.legal = false;
    result.reason += ` | power/weight ${powerKw}/${kg} > 0.2 kW/kg`;
  }

  return result;
}
