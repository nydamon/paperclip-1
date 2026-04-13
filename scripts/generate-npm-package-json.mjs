#!/usr/bin/env node
/**
 * generate-npm-package-json.mjs
 *
 * Reads the dev package.json (which has workspace:* refs) and produces
 * a publishable package.json in cli/ with:
 *   - workspace:* dependencies removed
 *   - all external dependencies from workspace packages inlined
 *   - proper metadata for npm
 *
 * Always reads CLI version from cli/package.json (which setVersion has
 * already updated with the target version before build-npm.sh runs).
 * The dev backup (cli/package.dev.json) is NOT used as a version source
 * because it may persist from a prior CI run with a stale version.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function readPkg(relativePath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath, "package.json"), "utf8"));
}

// Read all workspace packages that are BUNDLED into the CLI.
// Note: "server" is excluded — it's published separately as a dependency.
const workspacePaths = [
  "cli",
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/opencode-local",
  "packages/adapters/openclaw-gateway",
];

// Workspace packages that are NOT bundled and must stay as npm dependencies.
// These get published separately and resolved at runtime.
const externalWorkspacePackages = new Set([
  "@paperclipai/server",
]);

// Collect all external dependencies from all workspace packages
const allDeps = {};
const allOptionalDeps = {};

for (const pkgPath of workspacePaths) {
  const pkg = readPkg(pkgPath);
  const deps = pkg.dependencies || {};
  const optDeps = pkg.optionalDependencies || {};

  for (const [name, version] of Object.entries(deps)) {
    if (name.startsWith("@paperclipai/") && !externalWorkspacePackages.has(name)) continue;
    // For external workspace packages, read their version directly
    if (externalWorkspacePackages.has(name)) {
      const pkgDirMap = { "@paperclipai/server": "server" };
      const wsPkg = readPkg(pkgDirMap[name]);
      allDeps[name] = wsPkg.version;
      continue;
    }
    // Keep the more specific (pinned) version if conflict
    if (!allDeps[name] || !version.startsWith("^")) {
      allDeps[name] = version;
    }
  }

  for (const [name, version] of Object.entries(optDeps)) {
    allOptionalDeps[name] = version;
  }
}

// Sort alphabetically
const sortedDeps = Object.fromEntries(Object.entries(allDeps).sort(([a], [b]) => a.localeCompare(b)));
const sortedOptDeps = Object.fromEntries(
  Object.entries(allOptionalDeps).sort(([a], [b]) => a.localeCompare(b)),
);

// Read the CLI package metadata.
// Always read from cli/package.json — setVersion has already updated it
// with the target version (e.g. 2026.413.0-canary.2). The dev backup
// (cli/package.dev.json) may persist from a prior CI run with a stale
// version (e.g. 0.3.1) and must not be used as a version source.
const cliPkg = readPkg("cli");

// Build the publishable package.json
const publishPkg = {
  name: cliPkg.name,
  version: cliPkg.version,
  description: cliPkg.description,
  type: cliPkg.type,
  bin: cliPkg.bin,
  keywords: cliPkg.keywords,
  license: cliPkg.license,
  repository: cliPkg.repository,
  homepage: cliPkg.homepage,
  bugs: cliPkg.bugs,
  files: cliPkg.files,
  engines: { node: ">=20" },
  dependencies: sortedDeps,
};

if (Object.keys(sortedOptDeps).length > 0) {
  publishPkg.optionalDependencies = sortedOptDeps;
}

const output = JSON.stringify(publishPkg, null, 2) + "\n";
const outPath = resolve(repoRoot, "cli/package.json");
writeFileSync(outPath, output);

console.log(`  ✓  Generated publishable package.json (${Object.keys(sortedDeps).length} deps)`);
console.log(`     Version: ${cliPkg.version}`);
