#!/usr/bin/env node
/**
 * Copies the Console's static assets into their packaged output directories.
 */
import { mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(pkgDir, "scripts", "console", "dashboard");
const dest = path.join(pkgDir, "resources", "console", "client");
const boardSrc = path.join(pkgDir, "scripts", "console", "board-assets");
const boardDest = path.join(pkgDir, "resources", "console", "board-assets");
const repoRoot = path.resolve(pkgDir, "..", "..");

mkdirSync(dest, { recursive: true });
for (const file of ["index.html", "style.css"]) {
  copyFileSync(path.join(src, file), path.join(dest, file));
}

mkdirSync(path.join(boardDest, "vendor"), { recursive: true });
for (const file of ["app.js", "index.html", "style.css"]) {
  copyFileSync(path.join(boardSrc, file), path.join(boardDest, file));
}
copyFileSync(
  path.join(boardSrc, "vendor", "pixi.min.js"),
  path.join(boardDest, "vendor", "pixi.min.js"),
);

// The console user guide is served to the client as /guide.md so the Help
// modal can render it. Source of truth lives in the repo's docs/ directory.
copyFileSync(
  path.join(repoRoot, "docs", "forge-console-user-guide.md"),
  path.join(dest, "guide.md"),
);

console.log(`Copied Console client and Board assets into ${dest}`);
