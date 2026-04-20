#!/usr/bin/env node
/**
 * Blog Audit Sweep — runs scripts/seo-audit.mjs against every URL in the sitemap.
 *
 * Used by the content-canary GitHub Actions workflow to detect the class of
 * regressions where a task is marked done in Paperclip but the live production
 * page was never actually updated.
 *
 * Exit codes:
 *   0 = all blog URLs pass 10/10
 *   1 = at least one blog URL fails
 *   2 = sitemap fetch failed or auditor error
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SITE_URL = process.env.CANARY_SITE_URL || "https://viracue.ai";
const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;
const AUDITOR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "seo-audit.mjs");

async function fetchSitemap() {
  const res = await fetch(SITEMAP_URL, {
    headers: { "User-Agent": "Paperclip-Blog-Audit-Sweep/1.0" },
  });
  if (!res.ok) throw new Error(`sitemap fetch failed: HTTP ${res.status}`);
  return await res.text();
}

function extractBlogUrls(sitemap) {
  const urls = [];
  const re = /<loc>([^<]+\/blog\/[^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(sitemap)) !== null) urls.push(m[1]);
  return urls;
}

function runAudit(url) {
  return new Promise((resolve) => {
    const proc = spawn("node", [AUDITOR_PATH, url], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      resolve({ url, exitCode: code, parsed, stderr });
    });
    proc.on("error", (err) => {
      resolve({ url, exitCode: 2, parsed: null, stderr: err.message });
    });
  });
}

async function main() {
  console.log(`Blog audit sweep: ${SITE_URL}`);
  console.log(`Sitemap: ${SITEMAP_URL}`);
  console.log(`Auditor: ${AUDITOR_PATH}`);
  console.log("");

  let sitemap;
  try {
    sitemap = await fetchSitemap();
  } catch (err) {
    console.error(`Sitemap error: ${err.message}`);
    process.exit(2);
  }

  const urls = extractBlogUrls(sitemap);
  if (urls.length === 0) {
    console.error("No blog URLs in sitemap — regression or sitemap issue");
    process.exit(2);
  }

  console.log(`Found ${urls.length} blog URLs\n`);

  const results = [];
  for (const url of urls) {
    const result = await runAudit(url);
    results.push(result);
  }

  // Report
  console.log("## Blog Audit Sweep\n");
  console.log("| URL | Verdict | Score | Author | Blockers |");
  console.log("|-----|---------|-------|--------|----------|");
  for (const r of results) {
    const slug = r.url.replace(SITE_URL, "");
    if (!r.parsed) {
      console.log(`| ${slug} | TOOL_ERROR | - | - | exit ${r.exitCode} |`);
      continue;
    }
    const p = r.parsed;
    const verdict = p.score?.verdict || "UNKNOWN";
    const score = `${p.score?.passed || 0}/${p.score?.total || 0}`;
    const author = p.checks?.author?.name || "(none)";
    const blockerIds = (p.blockers || []).map((b) => b.id).join(", ") || "none";
    console.log(`| ${slug} | ${verdict} | ${score} | ${author} | ${blockerIds} |`);
  }

  const fails = results.filter((r) => r.exitCode !== 0);
  const passes = results.length - fails.length;
  console.log(`\n**Summary:** ${passes}/${results.length} passed, ${fails.length} failed\n`);

  if (fails.length > 0) {
    console.log("## Failure Details\n");
    for (const r of fails) {
      const slug = r.url.replace(SITE_URL, "");
      console.log(`### ${slug}`);
      if (!r.parsed) {
        console.log(`- Tool error, exit ${r.exitCode}`);
        console.log("");
        continue;
      }
      console.log(`- Verdict: ${r.parsed.score?.verdict}`);
      console.log(`- Failed checks:`);
      for (const c of r.parsed.score?.criteria || []) {
        if (!c.pass) console.log(`  - ❌ ${c.id}`);
      }
      console.log(`- Blockers:`);
      for (const b of r.parsed.blockers || []) {
        console.log(`  - **${b.id}** (${b.severity}): ${b.detail}`);
      }
      console.log("");
    }
    process.exit(1);
  }

  console.log("All blog posts pass 10/10. Nothing to fix.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`Sweep failed: ${err.message}`);
  process.exit(2);
});
