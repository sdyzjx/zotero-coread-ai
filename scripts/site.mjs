// Build the website (coread.doosam.uk) into build/site:
//   - static pages from site/
//   - a public XPI (never contains the .env API key) under /download/
//   - updates.json, the update manifest Zotero polls (manifest.json → update_url)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "addon/manifest.json"), "utf8"));
const SITE = (manifest.homepage_url || "https://coread.doosam.uk").replace(/\/+$/, "");
const out = path.join(root, "build/site");

execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), "--public"], { stdio: "inherit" });
const built = path.join(root, `build/zotero-coread-ai-${pkg.version}.xpi`);
const xpiName = `coread-ai-${pkg.version}.xpi`;

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "download"), { recursive: true });
await cp(path.join(root, "site"), out, { recursive: true });
await cp(path.join(root, "assets/logo.svg"), path.join(out, "logo.svg"));
await cp(built, path.join(out, "download", xpiName));
await cp(built, path.join(out, "download", "coread-ai-latest.xpi"));

const bytes = await readFile(built);
const hash = createHash("sha256").update(bytes).digest("hex");
const updates = {
  addons: {
    [manifest.applications.zotero.id]: {
      updates: [
        {
          version: pkg.version,
          update_link: `${SITE}/download/${xpiName}`,
          update_hash: `sha256:${hash}`,
          applications: { zotero: { strict_min_version: manifest.applications.zotero.strict_min_version || "7.0" } },
        },
      ],
    },
  },
};
await writeFile(path.join(out, "updates.json"), JSON.stringify(updates, null, 2) + "\n");

// Version placeholders in the pages
const size = `${(bytes.length / 1024 / 1024).toFixed(1)} MB`;
for (const page of ["index.html"]) {
  const p = path.join(out, page);
  const html = (await readFile(p, "utf8")).replaceAll("{{VERSION}}", pkg.version).replaceAll("{{XPI}}", `/download/${xpiName}`).replaceAll("{{SIZE}}", size).replaceAll("{{SHA256}}", hash);
  await writeFile(p, html);
}
console.log(`Site ready in ${path.relative(root, out)} (v${pkg.version}, ${size}, sha256 ${hash.slice(0, 12)}…)`);
