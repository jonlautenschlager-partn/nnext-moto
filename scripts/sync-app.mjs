// Syncs UI files from private repo (app/) to the public Pages repo (nnext-moto-app).
// Locally: pushes via gh's stored credentials (https).
// In Actions: uses APP_DEPLOY_KEY ssh secret if present.
import { mkdtemp, cp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const OWNER = process.env.GITHUB_REPOSITORY?.split("/")[0] || "jonlautenschlager-partn";
const APP_REPO = "nnext-moto-app";
const APP_DIR = join(ROOT, "app");

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", ...opts });
}

async function main() {
  // sanity: app dir must exist
  let hadApp = false;
  try {
    await readFile(join(APP_DIR, "index.html"));
    hadApp = true;
  } catch {
    console.error("app/index.html missing — nothing to sync");
    process.exit(0);
  }
  if (!hadApp) return;

  const tmp = await mkdtemp(join(tmpdir(), "nnext-app-"));
  const sshKey = process.env.APP_DEPLOY_KEY;
  let cloneUrl = `https://github.com/${OWNER}/${APP_REPO}.git`;
  let gitEnv; // undefined => inherit current environment

  if (sshKey) {
    const keyPath = join(tmp, "deploy_key");
    await writeFile(keyPath, sshKey + "\n", { mode: 0o600 });
    await mkdir(join(tmp, "ssh"), { recursive: true });
    gitEnv = {
      ...process.env,
      GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
    };
    cloneUrl = `git@github.com:${OWNER}/${APP_REPO}.git`;
  }

  try {
    run(`git clone --depth 1 ${cloneUrl} ${tmp}/repo`, { env: gitEnv });
    // copy UI files
    await cp(APP_DIR, join(tmp, "repo"), { recursive: true });
    // ensure no data files ever leak into the public repo
    for (const f of ["data.js", "listings.json"]) {
      await rm(join(tmp, "repo", f), { force: true });
      await rm(join(tmp, "repo", "dashboard", f), { force: true });
    }
    run(`git -C ${tmp}/repo add -A`);
    let changed = false;
    try {
      run(`git -C ${tmp}/repo diff --cached --quiet`);
    } catch {
      changed = true;
    }
    if (changed) {
      run(`git -C ${tmp}/repo -c user.name=nnext-bot -c user.email=41898282+github-actions[bot]@users.noreply.github.com commit -m "sync UI"`);
      run(`git -C ${tmp}/repo push origin HEAD`, { env: gitEnv });
      console.log(`Synced app -> ${OWNER}/${APP_REPO}`);
    } else {
      console.log("App UI unchanged — no sync needed");
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
