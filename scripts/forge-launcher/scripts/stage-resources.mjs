#!/usr/bin/env node
/**
 * Stages forge templates, docs, and execution utilities into resources/ so the
 * published package bootstraps standalone. Runs as part of `npm pack` (prepack).
 * Excludes node_modules/dist, matching bootstrap's copy behaviour.
 * Clears only the paths it manages, preserving tracked files (resources/.gitkeep).
 */
import { mkdirSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(pkgDir, "..", "..", "..");
const resourcesDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(pkgDir, "..", "resources");

function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else copyFileSync(src, dest);
  }
}

mkdirSync(resourcesDir, { recursive: true });

// Clear only the generated paths; leave .gitkeep (and anything else tracked) alone.
rmSync(path.join(resourcesDir, "templates"), { recursive: true, force: true });
rmSync(path.join(resourcesDir, "prompt-playbook.md"), { force: true });
rmSync(path.join(resourcesDir, "tools", "dapr-engine", "execution"), { recursive: true, force: true });

copyTree(path.join(repoRoot, "templates"), path.join(resourcesDir, "templates"));
copyTree(
  path.join(repoRoot, "tools", "dapr-engine", "execution"),
  path.join(resourcesDir, "tools", "dapr-engine", "execution"),
);
copyFileSync(
  path.join(repoRoot, "docs", "prompt-playbook.md"),
  path.join(resourcesDir, "prompt-playbook.md"),
);

console.log(`Staged templates/, execution utilities, and prompt-playbook.md into ${resourcesDir}`);
