// Downloads listing photos into data/images/<id>/ so they survive ad deletion.
// Idempotent: skips files already present. Max 10 images per listing.
// Falls back to the user's inbox screenshot when a listing has no photos at all.
import { mkdir, access, writeFile, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ROOT } from "./lib.mjs";

const IMAGES_DIR = join(DATA_DIR, "images");
const MAX_IMAGES = 10;
const MAX_BYTES = 6 * 1024 * 1024;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function extOf(url) {
  const m = String(url).match(/\.(jpe?g|png|webp)(?:$|[?&])/i);
  return m ? m[1].toLowerCase() : "jpg";
}

async function downloadOne(url, filePath) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") || "";
    if (!/image\//.test(type)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return false;
    await writeFile(filePath, buf);
    return true;
  } catch {
    return false;
  }
}

export async function downloadImages(listings) {
  await mkdir(IMAGES_DIR, { recursive: true });
  let total = 0;
  for (const l of listings) {
    const urls = (l.images || []).slice(0, MAX_IMAGES);
    if (!urls.length) continue;
    const dir = join(IMAGES_DIR, l.id);
    await mkdir(dir, { recursive: true });
    const local = [];
    for (let i = 0; i < urls.length; i++) {
      const ext = extOf(urls[i]);
      const name = `${i}.${ext}`;
      const filePath = join(dir, name);
      let ok = await exists(filePath);
      if (!ok) ok = await downloadOne(urls[i], filePath);
      if (ok) local.push(name);
    }
    if (local.length) {
      l.localImages = local;
      total += local.length;
      continue;
    }
    // no photos scraped: use the inbox screenshot (if any) as the cover image
    const shot = join(ROOT, "inbox", `${l.id}.jpg`);
    if (await exists(shot)) {
      const dir = join(IMAGES_DIR, l.id);
      await mkdir(dir, { recursive: true });
      const target = join(dir, "0.jpg");
      if (!(await exists(target))) await copyFile(shot, target);
      l.localImages = ["0.jpg"];
      total++;
      if (!l.notes?.includes("imagen desde captura del anuncio")) {
        l.notes = [...new Set([...(l.notes || []), "imagen desde captura del anuncio"])].slice(-5);
      }
    }
  }
  return total;
}

export async function countArchived() {
  try {
    const dirs = await readdir(IMAGES_DIR);
    return dirs.length;
  } catch {
    return 0;
  }
}
