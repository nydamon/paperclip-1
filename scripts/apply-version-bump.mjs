#!/usr/bin/env node

/**
 * Reads an AI-review JSON result (default: /tmp/review-result.json) and
 * applies the suggested version bumps to package.json and/or
 * chrome-extension/manifest.json. Idempotent: if the branch already contains
 * an [ai-fix] bump commit on HEAD or the suggested bump is "none" for every
 * dial, the script exits without touching the tree.
 *
 * Exits 0 on success whether or not a bump was applied. Prints a single-line
 * JSON summary to stdout so the calling workflow can surface it.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE_JSON = "package.json";
const MANIFEST_JSON = "chrome-extension/manifest.json";

function log(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

export function bumpSemver(current, level) {
  const match = String(current || "").match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) throw new Error(`Cannot parse version: ${current}`);
  let [, major, minor, patch] = match;
  major = Number(major);
  minor = Number(minor);
  patch = Number(patch);
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump level: ${level}`);
  }
}

function rankLevel(level) {
  return { none: 0, patch: 1, minor: 2, major: 3 }[level] ?? 0;
}

export function maxLevel(a, b) {
  return rankLevel(a) >= rankLevel(b) ? a : b;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonPreservingFormat(path, updater) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  const updated = updater(parsed);
  const indentMatch = raw.match(/^(\s+)"/m);
  const indent = indentMatch ? indentMatch[1] : "  ";
  const endsWithNewline = raw.endsWith("\n");
  writeFileSync(
    path,
    JSON.stringify(updated, null, indent) + (endsWithNewline ? "\n" : ""),
  );
}

function hasAiBumpOnHead() {
  try {
    const subject = sh("git log -1 --pretty=%s HEAD");
    return subject.startsWith("[ai-fix] bump");
  } catch {
    return false;
  }
}

async function main() {
  const reviewPath = process.argv[2] || "/tmp/review-result.json";
  const resolvedReview = resolve(reviewPath);

  if (!existsSync(resolvedReview)) {
    log({ status: "skipped", reason: "review-result-missing", path: resolvedReview });
    return;
  }

  let review;
  try {
    review = readJson(resolvedReview);
  } catch (err) {
    log({ status: "skipped", reason: "review-result-parse-error", error: String(err.message || err) });
    return;
  }

  const VALID = new Set(["major", "minor", "patch"]);
  const normalize = (v) => (VALID.has(String(v || "").toLowerCase()) ? String(v).toLowerCase() : null);
  const bump = review?.versionBump || {};
  const appLevel = normalize(bump.app);
  const extLevel = normalize(bump.extension);

  if (!appLevel && !extLevel) {
    log({ status: "skipped", reason: "no-bump-suggested" });
    return;
  }

  if (hasAiBumpOnHead()) {
    log({ status: "skipped", reason: "bump-already-on-head" });
    return;
  }

  const summary = { status: "applied", changes: [] };

  if (appLevel && existsSync(PACKAGE_JSON)) {
    const pkg = readJson(PACKAGE_JSON);
    const fromVersion = pkg.version;
    const toVersion = bumpSemver(fromVersion, appLevel);
    if (fromVersion !== toVersion) {
      writeJsonPreservingFormat(PACKAGE_JSON, (obj) => ({ ...obj, version: toVersion }));
      summary.changes.push({ file: PACKAGE_JSON, from: fromVersion, to: toVersion, level: appLevel });
    }
  }

  if (extLevel && existsSync(MANIFEST_JSON)) {
    const manifest = readJson(MANIFEST_JSON);
    const fromVersion = manifest.version;
    const toVersion = bumpSemver(fromVersion, extLevel);
    if (fromVersion !== toVersion) {
      writeJsonPreservingFormat(MANIFEST_JSON, (obj) => ({ ...obj, version: toVersion }));
      summary.changes.push({ file: MANIFEST_JSON, from: fromVersion, to: toVersion, level: extLevel });
    }
  }

  if (summary.changes.length === 0) {
    log({ status: "skipped", reason: "no-files-to-bump" });
    return;
  }

  const commitMessage = [
    "[ai-fix] bump " +
      summary.changes
        .map((c) => `${c.file.includes("manifest") ? "extension" : "app"} ${c.from}->${c.to}`)
        .join(", "),
    "",
    `AI-suggested bump: ${bump.rationale || "no rationale provided"}`,
  ].join("\n");

  sh('git config user.name "ai-review[bot]"');
  sh('git config user.email "ai-review[bot]@users.noreply.github.com"');
  sh(`git add ${summary.changes.map((c) => c.file).join(" ")}`);

  const msgDir = mkdtempSync(join(tmpdir(), "ai-bump-"));
  const msgFile = join(msgDir, "COMMIT_MSG");
  try {
    writeFileSync(msgFile, commitMessage);
    sh(`git commit -F ${JSON.stringify(msgFile)}`);
  } finally {
    rmSync(msgDir, { recursive: true, force: true });
  }
  sh("git push origin HEAD");

  log({ ...summary, rationale: bump.rationale || "" });
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    log({ status: "error", error: String(err?.message || err) });
    process.exit(0);
  });
}
