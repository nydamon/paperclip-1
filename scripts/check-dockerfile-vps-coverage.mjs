#!/usr/bin/env node
/**
 * Verifies Dockerfile.vps covers every workspace package in its deps stage COPY block,
 * and that every plugin declaring a manifest/worker has an explicit build step.
 *
 * Run: node scripts/check-dockerfile-vps-coverage.mjs
 * Exit 0 = pass, exit 1 = failures printed to stderr.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const dockerfile = readFileSync(resolve(root, "Dockerfile.vps"), "utf8");

// Split into named stages
const stagePattern = /FROM\s+\S+\s+AS\s+(\w+)([\s\S]*?)(?=\nFROM\s|\s*$)/g;
const stages = {};
for (const m of dockerfile.matchAll(stagePattern)) {
  stages[m[1]] = m[2];
}

if (!stages.deps) {
  console.error("ERROR: could not find 'deps' stage in Dockerfile.vps");
  process.exit(1);
}
if (!stages.build) {
  console.error("ERROR: could not find 'build' stage in Dockerfile.vps");
  process.exit(1);
}

// Collect all COPY <path>/package.json lines from deps stage
const copiedPkgJsons = new Set(
  [...stages.deps.matchAll(/^COPY\s+(\S+\/package\.json)\s+/gm)].map((m) =>
    m[1].replace(/\\/g, "/")
  )
);

const errors = [];

function requireCopy(pkgRelPath) {
  const expected = `${pkgRelPath}/package.json`;
  if (!copiedPkgJsons.has(expected)) {
    errors.push(`MISSING deps COPY: ${expected}`);
  }
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// Top-level workspace packages
for (const pkg of ["cli", "server", "ui"]) {
  if (existsSync(resolve(root, pkg, "package.json"))) requireCopy(pkg);
}

// packages/* direct children (excluding plugins/ and adapters/ subdirs)
for (const name of listDirs(resolve(root, "packages"))) {
  if (name === "plugins" || name === "adapters") continue;
  const rel = `packages/${name}`;
  if (existsSync(resolve(root, rel, "package.json"))) requireCopy(rel);
}

// packages/adapters/*
for (const name of listDirs(resolve(root, "packages/adapters"))) {
  const rel = `packages/adapters/${name}`;
  if (existsSync(resolve(root, rel, "package.json"))) requireCopy(rel);
}

// packages/plugins/* (direct, skip examples/)
for (const name of listDirs(resolve(root, "packages/plugins"))) {
  if (name === "examples") continue;
  const rel = `packages/plugins/${name}`;
  const pkgJsonPath = resolve(root, rel, "package.json");
  if (!existsSync(pkgJsonPath)) continue;

  requireCopy(rel);

  // If this plugin declares a manifest or worker, it must have a build step
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson.paperclipPlugin?.manifest || pkgJson.paperclipPlugin?.worker) {
    const pluginName = pkgJson.name;
    const hasFilter =
      stages.build.includes(`--filter ${pluginName}`) ||
      stages.build.includes(`--filter="${pluginName}"`);
    if (!hasFilter) {
      errors.push(
        `MISSING build step for plugin with manifest: ${pluginName} (${rel})`
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Dockerfile.vps coverage check FAILED:");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log("Dockerfile.vps coverage check passed.");
