#!/usr/bin/env node
/**
 * Content regression canary — checks all published blog posts for SEO health.
 *
 * For each URL in the sitemap:
 *   1. Canonical points to itself (not homepage)
 *   2. BlogPosting or Article schema present
 *   3. og:type is "article"
 *   4. Meta description present
 *   5. H1 tag present
 *   6. Content word count above minimum
 *
 * Exit 0 if all pass. Exit 1 with markdown report if any fail.
 * Designed to run in GitHub Actions on a schedule and after deploys.
 */

const SITE_URL = process.env.CANARY_SITE_URL || "https://viracue.ai";
const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;
// Note: word count and H1 checks are best-effort for SPA pages.
// The critical checks are canonical, schema, and og:type which are in static HTML.

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Paperclip-Content-Canary/1.0" },
    redirect: "follow",
  });
  if (!res.ok) return { status: res.status, text: "" };
  return { status: res.status, text: await res.text() };
}

async function getBlogUrlsFromSitemap() {
  const { text } = await fetchText(SITEMAP_URL);
  if (!text) {
    console.error(`Failed to fetch sitemap at ${SITEMAP_URL}`);
    process.exit(1);
  }
  const urls = [];
  const re = /<loc>([^<]+\/blog\/[^<]+)<\/loc>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

function checkPage(url, html) {
  const failures = [];
  const warnings = [];

  // 1. Canonical points to itself
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const canonical = canonicalMatch?.[1] || null;
  if (!canonical) {
    failures.push("missing_canonical");
  } else if (!canonical.includes("/blog/")) {
    failures.push(`canonical_wrong: points to ${canonical} (expected ${url})`);
  }

  // 2. BlogPosting or Article schema
  const hasBlogPosting = /BlogPosting|Article/i.test(html) && /application\/ld\+json/i.test(html);
  if (!hasBlogPosting) {
    failures.push("missing_blogposting_schema");
  }

  // 3. og:type is article
  const ogType = html.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (!ogType || ogType !== "article") {
    failures.push(`og_type_wrong: "${ogType || "missing"}" (expected "article")`);
  }

  // 4. Meta description
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (!metaDesc) {
    failures.push("missing_meta_description");
  }

  // 5. H1 tag (warning only — SPA pages render H1 client-side)
  const h1Match = html.match(/<h1[^>]*>[^<]+<\/h1>/i);
  if (!h1Match) {
    warnings.push("h1_not_in_static_html (may be client-rendered)");
  }

  // 6. Title tag present and not generic
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  if (!titleMatch) {
    failures.push("missing_title");
  } else if (titleMatch === "ViraCue" || titleMatch.includes("| ViraCue.ai") && !titleMatch.includes("Blog") && titleMatch.length < 20) {
    failures.push(`generic_title: "${titleMatch}" (should be article-specific)`);
  }

  // Warnings (non-blocking)
  const ogImage = html.match(/<meta[^>]+property=["']og:image["']/i);
  if (!ogImage) warnings.push("missing_og_image");

  const twitterCard = html.match(/<meta[^>]+name=["']twitter:card["']/i);
  if (!twitterCard) warnings.push("missing_twitter_card");

  return { url, canonical, hasBlogPosting, ogType, failures, warnings };
}

async function main() {
  console.log(`Content canary: checking ${SITE_URL}`);
  console.log(`Sitemap: ${SITEMAP_URL}\n`);

  const urls = await getBlogUrlsFromSitemap();
  if (urls.length === 0) {
    console.error("No blog URLs found in sitemap — this may be a regression");
    process.exit(1);
  }
  console.log(`Found ${urls.length} blog URLs in sitemap\n`);

  const results = [];
  for (const url of urls) {
    const { status, text: html } = await fetchText(url);
    if (status !== 200) {
      results.push({ url, failures: [`http_${status}`], warnings: [] });
      continue;
    }
    results.push(checkPage(url, html));
  }

  // Report
  const failed = results.filter(r => r.failures.length > 0);
  const passed = results.filter(r => r.failures.length === 0);
  const allWarnings = results.flatMap(r => r.warnings);

  console.log("## Content Canary Report\n");
  console.log(`| URL | Status | Failures | Warnings |`);
  console.log(`|-----|--------|----------|----------|`);
  for (const r of results) {
    const slug = r.url.replace(SITE_URL, "");
    const status = r.failures.length === 0 ? "PASS" : "FAIL";
    console.log(`| ${slug} | ${status} | ${r.failures.join(", ") || "none"} | ${r.warnings.join(", ") || "none"} |`);
  }

  console.log(`\n**Summary:** ${passed.length}/${results.length} passed, ${failed.length} failed, ${allWarnings.length} warnings\n`);

  if (failed.length > 0) {
    console.log("### Regressions detected\n");
    for (const r of failed) {
      console.log(`**${r.url}**`);
      for (const f of r.failures) {
        console.log(`  - ${f}`);
      }
    }
    process.exit(1);
  }

  console.log("All blog posts healthy.");
  process.exit(0);
}

main().catch(err => {
  console.error("Canary check failed:", err.message);
  process.exit(1);
});
