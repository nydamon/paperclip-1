#!/usr/bin/env node
/**
 * SEO Audit Tool — deterministic HTML-level checks for qa-domain-review standards.
 *
 * This script performs REAL technical SEO checks by fetching the live URL and
 * parsing the actual HTML served. No LLM reasoning, no self-scoring, no bias.
 *
 * Agents MUST call this before claiming a page passes SEO review. The JSON
 * output is the ground truth — the LLM's job is to read it, not invent it.
 *
 * Usage:
 *   node scripts/seo-audit.mjs <url>                 JSON output (default)
 *   node scripts/seo-audit.mjs <url> --markdown      Markdown report
 *   node scripts/seo-audit.mjs <url> --raw-html      Dump raw HTML body sample
 *
 * Exit codes:
 *   0 = PASS (all 10 checklist items passed, zero blockers)
 *   1 = FAIL (at least one blocker OR checklist score < 10)
 *   2 = Error (fetch failed, bad args, unreachable URL)
 *
 * Zero external dependencies. Runs on Node 20+ with native fetch.
 */

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const format = args.includes("--markdown") ? "markdown" : "json";
const debugHtml = args.includes("--raw-html");

if (!url) {
  console.error("Usage: node scripts/seo-audit.mjs <url> [--json|--markdown]");
  process.exit(2);
}

async function fetchPage(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: { "User-Agent": "Paperclip-SEO-Audit/1.0 (+https://paperclip.ing)" },
    redirect: "follow",
  });
  const text = await res.text();
  return { status: res.status, finalUrl: res.url, html: text };
}

function extractOne(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

function extractAll(html, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null) out.push(m);
  return out;
}

function parseJsonLd(html) {
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch {
      // ignore unparseable blocks
    }
  }
  return blocks;
}

function flattenSchemas(blocks) {
  const types = [];
  const items = [];
  const seen = new WeakSet();
  const collect = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) {
      obj.forEach(collect);
      return;
    }
    if (obj["@type"]) {
      const t = obj["@type"];
      if (Array.isArray(t)) types.push(...t);
      else types.push(t);
      items.push(obj);
    }
    for (const key of Object.keys(obj)) {
      if (key === "@context" || key === "@type") continue;
      const val = obj[key];
      if (val && typeof val === "object") collect(val);
    }
  };
  blocks.forEach(collect);
  return { types, items };
}

function stripScriptsAndStyles(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
}

function extractRegionByTag(html, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
}

function textContentOnly(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function auditPage(targetUrl, status, html) {
  const checks = {};
  const blockers = [];
  const warnings = [];

  const cleanedHtml = stripScriptsAndStyles(html);
  const articleRegion = extractRegionByTag(cleanedHtml, "article") || extractRegionByTag(cleanedHtml, "main");
  const bodyText = articleRegion ? textContentOnly(articleRegion) : "";
  const bodyWordCount = countWords(bodyText);
  const urlObj = new URL(targetUrl);

  // HTTP status
  checks.http_status = status;
  if (status !== 200) {
    blockers.push({ id: "non_200_status", severity: "critical", detail: `HTTP ${status}` });
  }

  // Meta title
  const title = extractOne(html, /<title[^>]*>([^<]+)<\/title>/i);
  checks.meta_title = {
    present: !!title,
    value: title,
    length: title ? title.length : 0,
  };
  if (!title) {
    blockers.push({ id: "missing_meta_title", severity: "critical", detail: "<title> tag absent or empty" });
  } else if (title.length < 30 || title.length > 60) {
    warnings.push({ id: "meta_title_length", detail: `Title is ${title.length} chars (recommended 30-60)` });
  }

  // Meta description
  const metaDesc =
    extractOne(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    extractOne(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  checks.meta_description = {
    present: !!metaDesc,
    value: metaDesc,
    length: metaDesc ? metaDesc.length : 0,
  };
  if (!metaDesc) {
    blockers.push({ id: "missing_meta_description", severity: "critical", detail: '<meta name="description"> absent' });
  } else if (metaDesc.length < 120 || metaDesc.length > 160) {
    warnings.push({ id: "meta_description_length", detail: `Description is ${metaDesc.length} chars (recommended 120-160)` });
  }

  // Canonical
  const canonical =
    extractOne(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    extractOne(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  let canonicalSelfRef = false;
  if (canonical) {
    try {
      const canonUrl = new URL(canonical, targetUrl);
      canonicalSelfRef =
        canonUrl.hostname === urlObj.hostname &&
        canonUrl.pathname.replace(/\/$/, "") === urlObj.pathname.replace(/\/$/, "");
    } catch {
      canonicalSelfRef = false;
    }
  }
  checks.canonical = {
    present: !!canonical,
    value: canonical,
    self_referential: canonicalSelfRef,
  };
  if (!canonical) {
    blockers.push({ id: "missing_canonical", severity: "critical", detail: '<link rel="canonical"> absent' });
  } else if (!canonicalSelfRef) {
    blockers.push({
      id: "canonical_not_self_referential",
      severity: "critical",
      detail: `Canonical points to ${canonical}, not this URL`,
    });
  }

  // Robots meta
  const robots = extractOne(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i);
  checks.robots = {
    value: robots,
    noindex: robots ? /noindex/i.test(robots) : false,
  };
  if (checks.robots.noindex) {
    blockers.push({ id: "noindex_on_page", severity: "critical", detail: `robots meta: ${robots}` });
  }

  // OG tags
  const ogType = extractOne(html, /<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i);
  const ogTitle = extractOne(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const ogDesc = extractOne(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const ogImage = extractOne(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const ogUrl = extractOne(html, /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  checks.og_tags = {
    type: ogType,
    title: !!ogTitle,
    description: !!ogDesc,
    image: !!ogImage,
    url: !!ogUrl,
  };
  const missingOg = [];
  if (!ogTitle) missingOg.push("og:title");
  if (!ogDesc) missingOg.push("og:description");
  if (!ogImage) missingOg.push("og:image");
  if (missingOg.length > 0) {
    warnings.push({ id: "incomplete_og_tags", detail: `Missing: ${missingOg.join(", ")}` });
  }
  if (ogType && ogType !== "article") {
    blockers.push({
      id: "og_type_wrong",
      severity: "high",
      detail: `og:type is "${ogType}", expected "article" for blog posts`,
    });
  } else if (!ogType) {
    blockers.push({ id: "missing_og_type", severity: "high", detail: "og:type meta not set" });
  }

  // Twitter card
  const twitterCard = extractOne(html, /<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']+)["']/i);
  checks.twitter_card = { present: !!twitterCard, value: twitterCard };
  if (!twitterCard) {
    warnings.push({ id: "missing_twitter_card", detail: "twitter:card meta missing" });
  }

  // Headings
  const h1Matches = extractAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi);
  const h2Matches = extractAll(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi);
  const h3Matches = extractAll(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi);
  checks.headings = {
    h1_count: h1Matches.length,
    h2_count: h2Matches.length,
    h3_count: h3Matches.length,
    h1_text: h1Matches[0] ? textContentOnly(h1Matches[0][1]).slice(0, 200) : null,
  };
  if (h1Matches.length === 0) {
    blockers.push({ id: "missing_h1", severity: "critical", detail: "Page has no <h1> element" });
  } else if (h1Matches.length > 1) {
    blockers.push({
      id: "multiple_h1",
      severity: "critical",
      detail: `Page has ${h1Matches.length} <h1> elements`,
    });
  }
  // Heading hierarchy: flag if H3 appears before first H2
  const firstH2Idx = html.search(/<h2[\s>]/i);
  const firstH3Idx = html.search(/<h3[\s>]/i);
  if (firstH3Idx !== -1 && firstH2Idx !== -1 && firstH3Idx < firstH2Idx) {
    blockers.push({
      id: "heading_hierarchy_broken",
      severity: "high",
      detail: "H3 appears before first H2",
    });
  }

  // JSON-LD schemas
  const schemas = parseJsonLd(html);
  const { types, items } = flattenSchemas(schemas);
  const hasArticle = types.some((t) => /^(BlogPosting|Article|NewsArticle)$/i.test(t));
  const personItem = items.find((i) => {
    const t = Array.isArray(i["@type"]) ? i["@type"][0] : i["@type"];
    return /^Person$/i.test(String(t));
  });
  checks.schemas = {
    script_count: schemas.length,
    types_found: types,
    has_blogposting_or_article: hasArticle,
    has_organization: types.some((t) => /^Organization$/i.test(t)),
    has_person: !!personItem,
  };
  if (!hasArticle) {
    blockers.push({
      id: "missing_blogposting_schema",
      severity: "critical",
      detail: "No BlogPosting/Article/NewsArticle JSON-LD schema found",
    });
  }

  // Author validation
  if (personItem) {
    const authorName = personItem.name || null;
    let authorUrls = personItem.url || personItem.sameAs || null;
    if (Array.isArray(authorUrls)) authorUrls = authorUrls.join(" ");
    const isEditorial = authorName && /editorial|team|staff/i.test(authorName);
    const hasLinkedIn = authorUrls && /linkedin\.com/i.test(String(authorUrls));
    checks.author = {
      name: authorName,
      url: authorUrls,
      is_editorial_team: !!isEditorial,
      has_linkedin: !!hasLinkedIn,
    };
    if (isEditorial) {
      blockers.push({
        id: "author_is_editorial_team",
        severity: "critical",
        detail: `Author is "${authorName}" — use named individual, never a generic team label`,
      });
    }
    if (!hasLinkedIn) {
      blockers.push({
        id: "author_missing_linkedin",
        severity: "high",
        detail: "Person schema has no LinkedIn URL (url or sameAs)",
      });
    }
  } else {
    checks.author = { name: null, url: null, is_editorial_team: null, has_linkedin: false };
    blockers.push({
      id: "missing_author_schema",
      severity: "high",
      detail: "No Person JSON-LD schema found for author attribution",
    });
  }

  // Pre-rendered content
  checks.pre_rendered_content = {
    has_article_tag: /<article[\s>]/i.test(html),
    has_main_tag: /<main[\s>]/i.test(html),
    body_word_count: bodyWordCount,
  };
  if (bodyWordCount < 300) {
    blockers.push({
      id: "body_under_300_words",
      severity: "critical",
      detail: `Pre-rendered body has ${bodyWordCount} words (minimum 300)`,
    });
  }

  // Images and alt text (inside article region if available)
  const imgRegion = articleRegion || html;
  const imgTags = extractAll(imgRegion, /<img[^>]*>/gi);
  const withAlt = imgTags.filter((m) => /alt=["'][^"']*["']/i.test(m[0])).length;
  checks.images = {
    total: imgTags.length,
    with_alt: withAlt,
    without_alt: imgTags.length - withAlt,
    coverage_pct: imgTags.length > 0 ? Math.round((withAlt / imgTags.length) * 100) : 100,
  };
  if (imgTags.length > 0 && withAlt / imgTags.length < 0.7) {
    blockers.push({
      id: "images_missing_alt",
      severity: "high",
      detail: `${imgTags.length - withAlt}/${imgTags.length} images lack alt text`,
    });
  }

  // Internal links (inside article region)
  const internalLinks = extractAll(articleRegion || "", /<a[^>]+href=["']([^"']+)["']/gi)
    .map((m) => m[1])
    .filter((href) => {
      if (href.startsWith("/") && !href.startsWith("//")) return true;
      try {
        const u = new URL(href);
        return u.hostname === urlObj.hostname;
      } catch {
        return false;
      }
    });
  checks.internal_links = {
    count: internalLinks.length,
    targets: Array.from(new Set(internalLinks)).slice(0, 20),
  };
  if (internalLinks.length < 3) {
    warnings.push({
      id: "thin_internal_linking",
      detail: `Only ${internalLinks.length} internal links in body (recommend 3+)`,
    });
  }

  // Raw markdown in rendered body
  const mdLinkPattern = /\[[^\]\n]{1,120}\]\([^\s)]+\)/g;
  const mdBoldPattern = /\*\*[^*\n]{1,120}\*\*/g;
  const mdHeaderPattern = /(^|\s)##\s+[A-Z]/g;
  const mdLinks = bodyText.match(mdLinkPattern) || [];
  const mdBold = bodyText.match(mdBoldPattern) || [];
  const mdHeaders = bodyText.match(mdHeaderPattern) || [];
  checks.raw_markdown_in_body = {
    markdown_links_found: mdLinks.length,
    markdown_bold_found: mdBold.length,
    markdown_headers_found: mdHeaders.length,
    sample_link: mdLinks[0] || null,
    sample_bold: mdBold[0] || null,
  };
  if (mdLinks.length > 0) {
    blockers.push({
      id: "raw_markdown_links_in_body",
      severity: "critical",
      detail: `${mdLinks.length} markdown links rendering as raw text (e.g. ${mdLinks[0]})`,
    });
  }
  if (mdBold.length > 0) {
    warnings.push({
      id: "raw_markdown_bold_in_body",
      detail: `${mdBold.length} instances of **bold** rendering as raw text (e.g. ${mdBold[0]})`,
    });
  }

  // Research methodology detection (soft signal)
  const methodologyKeywords =
    /(based on|analysis of|we analyzed|\b\d{2,}\s*(customer|call|session|practice run|data point|team|rep))/i;
  const researchDetected = bodyText ? methodologyKeywords.test(bodyText) : false;
  checks.research_methodology = { detected: researchDetected };
  if (!researchDetected) {
    warnings.push({
      id: "no_research_methodology",
      detail: "No research methodology paragraph detected (e.g. 'based on X customer calls')",
    });
  }

  return { url: targetUrl, checks, blockers, warnings, body_text_sample: bodyText.slice(0, 300) };
}

function scoreResult(result) {
  const c = result.checks;
  const criteria = [
    { id: "http_200", pass: c.http_status === 200 },
    { id: "meta_title_present", pass: !!c.meta_title?.present },
    { id: "meta_description_present", pass: !!c.meta_description?.present },
    { id: "canonical_self_referential", pass: !!c.canonical?.self_referential },
    { id: "single_h1", pass: c.headings?.h1_count === 1 },
    { id: "og_type_article", pass: c.og_tags?.type === "article" },
    { id: "blogposting_schema_present", pass: !!c.schemas?.has_blogposting_or_article },
    {
      id: "named_author_with_linkedin",
      pass: !!(c.author?.has_linkedin && !c.author?.is_editorial_team && c.author?.name),
    },
    { id: "body_content_over_300_words", pass: (c.pre_rendered_content?.body_word_count || 0) >= 300 },
    { id: "no_raw_markdown_in_body", pass: (c.raw_markdown_in_body?.markdown_links_found || 0) === 0 },
  ];

  const passed = criteria.filter((x) => x.pass).length;
  const verdict = result.blockers.length === 0 && passed === criteria.length ? "PASS" : "FAIL";

  return { verdict, passed, total: criteria.length, criteria };
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# SEO Audit: ${r.url}`);
  lines.push("");
  lines.push(`**Verdict:** ${r.score.verdict} (${r.score.passed}/${r.score.total} checklist items)`);
  lines.push(`**Audited:** ${r.audited_at}`);
  lines.push("");

  if (r.blockers.length > 0) {
    lines.push(`## Blockers (${r.blockers.length})`);
    for (const b of r.blockers) lines.push(`- **${b.id}** (${b.severity}): ${b.detail}`);
    lines.push("");
  } else {
    lines.push("## Blockers");
    lines.push("None");
    lines.push("");
  }

  if (r.warnings.length > 0) {
    lines.push(`## Warnings (${r.warnings.length})`);
    for (const w of r.warnings) lines.push(`- ${w.id}: ${w.detail}`);
    lines.push("");
  }

  lines.push("## 10-Point Checklist");
  for (const c of r.score.criteria) {
    lines.push(`- ${c.pass ? "✅" : "❌"} ${c.id}`);
  }
  lines.push("");

  lines.push("## Key Signals");
  const c = r.checks;
  lines.push(`- HTTP status: ${c.http_status}`);
  lines.push(`- H1: ${c.headings?.h1_text || "(none)"}`);
  lines.push(`- Body word count: ${c.pre_rendered_content?.body_word_count || 0}`);
  lines.push(`- Canonical: ${c.canonical?.value || "(missing)"}`);
  lines.push(`- og:type: ${c.og_tags?.type || "(missing)"}`);
  lines.push(`- Schema types: ${(c.schemas?.types_found || []).join(", ") || "(none)"}`);
  lines.push(`- BlogPosting schema: ${c.schemas?.has_blogposting_or_article ? "YES" : "NO"}`);
  lines.push(`- Author: ${c.author?.name || "(none)"} / LinkedIn: ${c.author?.has_linkedin ? "YES" : "NO"}`);
  lines.push(`- Internal links in body: ${c.internal_links?.count || 0}`);
  lines.push(`- Raw markdown links in body: ${c.raw_markdown_in_body?.markdown_links_found || 0}`);

  return lines.join("\n");
}

async function main() {
  try {
    const { status, html } = await fetchPage(url);

    if (debugHtml) {
      console.log(html.slice(0, 2000));
      process.exit(0);
    }

    const result = auditPage(url, status, html);
    result.score = scoreResult(result);
    result.audited_at = new Date().toISOString();

    if (format === "markdown") {
      console.log(renderMarkdown(result));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    process.exit(result.score.verdict === "PASS" ? 0 : 1);
  } catch (err) {
    console.error(`SEO audit failed: ${err.message}`);
    process.exit(2);
  }
}

main();
