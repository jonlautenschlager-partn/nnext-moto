import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error("Usage: npm run add -- <listing-url>");
  process.exit(1);
}
const linksPath = join(ROOT, "links.txt");
let links = [];
try {
  links = (await readFile(linksPath, "utf8")).split("\n").map((s) => s.trim()).filter(Boolean).filter((l) => !l.startsWith("#"));
} catch {}
if (links.includes(url)) {
  console.log("Already in links.txt — nothing to do.");
  process.exit(0);
}
await appendFile(linksPath, url + "\n", "utf8");
console.log(`Added to links.txt (${links.length + 1} total). Run: npm run scrape`);
