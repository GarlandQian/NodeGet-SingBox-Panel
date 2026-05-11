import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const extensionDir = join(root, "extension");
const zipName = "nodeget-singbox-panel.zip";
const versionedZipName = `nodeget-singbox-panel-v${packageJson.version}.zip`;

await mkdir(distDir, { recursive: true });
await rm(join(distDir, zipName), { force: true });
await rm(join(distDir, versionedZipName), { force: true });

execFileSync(
  "zip",
  ["-qr", join(distDir, zipName), "app.json", "readme.md", "resources"],
  { cwd: extensionDir, stdio: "inherit" },
);

await cp(join(distDir, zipName), join(distDir, versionedZipName));

console.log(`wrote ${join(distDir, zipName)}`);
console.log(`wrote ${join(distDir, versionedZipName)}`);
