import { readJson, ROOT } from "./lib.mjs";
import { join } from "node:path";

let PROFILE = null;
export async function getProfile() {
  if (!PROFILE) PROFILE = await readJson(join(ROOT, "insurance-profile.json"), {});
  return PROFILE;
}

// Annual "terceros con grúa" estimate for the rider in insurance-profile.json.
// Calibrated on the real anchor: Honda CB125R = 214 EUR/yr (Madrid 28010, 29yo, shared garage).
// Transparent model: class base +- value/age adjustments, shown as a range (never a quote).
const CLASS_BASES = [
  // [minCc, maxCc, minEur, maxEur] — for THIS rider profile in Madrid 28010
  [0, 125, 190, 240],
  [126, 300, 235, 310],
  [301, 500, 285, 420],
  [501, 700, 345, 520],
  [701, 1200, 400, 620],
];

export async function estimateInsurance(listing) {
  const profile = await getProfile();
  const cc = listing.cc ?? null;
  const kw = listing.powerKw ?? (listing.powerCv ? listing.powerCv / 1.36 : null);
  let cls = CLASS_BASES[2]; // default 301-500
  if (cc != null) {
    cls = CLASS_BASES.find(([a, b]) => cc >= a && cc <= b) || cls;
  } else if (kw != null) {
    const equivCc = kw <= 11 ? 125 : kw <= 26 ? 300 : kw <= 36 ? 500 : kw <= 55 ? 700 : 1200;
    cls = CLASS_BASES.find(([a, b]) => equivCc >= a && equivCc <= b) || cls;
  }

  let [min, max] = [cls[2], cls[3]];

  // Bike value adjustments (terceros is mostly liability+grua, but assistance/theft-adjacent sections scale a bit)
  const price = listing.price ?? 0;
  if (price >= 10000) { min *= 1.2; max *= 1.25; }
  else if (price >= 6000) { min *= 1.1; max *= 1.15; }
  else if (price <= 2500 && cc > 300) { min *= 0.92; max *= 0.95; } // old cheap bikes cost less to insure

  // Bike age
  const year = listing.year ?? null;
  if (year) {
    const age = new Date().getFullYear() - year;
    if (age <= 1) { min *= 1.05; max *= 1.05; }
    if (age >= 10) { min *= 0.9; max *= 0.95; }
  }

  // Scooters usually cheaper to insure; big trail/touring slightly more
  if (listing.type === "scooter") { min *= 0.92; max *= 0.95; }
  if (listing.type === "trail" || listing.type === "touring") { min *= 1.03; max *= 1.05; }

  return {
    min: Math.round(min / 5) * 5,
    max: Math.round(max / 5) * 5,
    coverage: profile.coverageWanted || "terceros con grua",
    computedAt: new Date().toISOString(),
    disclaimer: "Estimate, not a quote. Calibrated on CB125R 214 eur/yr anchor for this rider profile.",
  };
}
