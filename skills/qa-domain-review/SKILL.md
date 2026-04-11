---
name: qa-domain-review
description: Domain-aware QA review protocol. Detects whether work produced web-facing content or email content and triggers the appropriate specialized review (SEO audit or email deliverability check) in addition to standard QA testing.
---

# QA Domain Review

Before every QA review, determine whether the work involves web-facing content, email content, or neither. This detection runs first -- before any functional testing -- because it decides which review tracks to include.

## Detection Logic

Run these checks against the issue description, work products, and any URLs in the PR/branch:

### 1. Web-facing content?

**Triggers SEO review** if ANY of these are true:
- Work product includes a URL on a public domain (viraforgelabs.com, viracue.com, prsecurelogistics.com, or any custom domain)
- Issue title or description mentions: blog post, landing page, marketing page, article, homepage, product page, pricing page, about page, documentation site, changelog page, public-facing page

**Does NOT apply to:**
- Internal dashboards and admin panels
- API endpoints (REST, GraphQL, webhooks)
- Paperclip UI (board views, agent config)
- Developer tools, CLI output, terminal interfaces
- Pages behind authentication that are not indexed

### 2. Email content?

**Triggers email deliverability review** if ANY of these are true:
- Work involves a Loops template, Mailchimp campaign, SendGrid template, or any ESP template
- Issue mentions: cold email, Gmail campaign, transactional email, lifecycle sequence, newsletter, drip campaign, welcome email, onboarding email, re-engagement email, abandoned cart email, promotional email
- Code changes include email HTML templates or email-sending logic

**Does NOT apply to:**
- Internal agent-to-agent notifications
- System alerts and monitoring emails
- Git commit notification emails
- Paperclip issue comment notifications

### 3. Neither?

Standard QA only. Skip both specialized tracks.

## SEO Review Track

When web-facing content is detected, run these checks in addition to functional QA.

### Automated checks

Run the SEO skill commands against each public-facing URL in the work product:

```
/seo page <url>     -- meta title, meta description, heading hierarchy, image alt text, links, canonical
/seo content <url>  -- E-E-A-T signals, readability grade, content depth, keyword presence
/seo audit <url>    -- Core Web Vitals, mobile-friendly, crawlability, schema markup (new pages or major rewrites only)
```

For minor content edits (typo fixes, copy tweaks), `/seo page` alone is sufficient. For new pages or major rewrites, run all three.

### SEO blocking failures (mark QA: FAIL)

Any one of these means the page should not ship:

| Check | Threshold |
|-------|-----------|
| Missing meta title | `<title>` tag absent or empty |
| Duplicate meta title | Same `<title>` as another page on the site |
| No H1 tag | Page has zero `<h1>` elements |
| Multiple H1 tags | Page has more than one `<h1>` element |
| Missing meta description | `<meta name="description">` absent or empty |
| Images missing alt text | More than 50% of `<img>` tags lack `alt` attribute |
| Blog/article under 300 words | Main content body (excluding nav, footer, sidebar) has fewer than 300 words |
| Page returns non-200 | HTTP status is not 200 for a page that should be live |
| Accidental noindex | `<meta name="robots" content="noindex">` on a page that should be indexed |

### SEO warnings (note in QA comment, do not block)

| Check | What to flag |
|-------|-------------|
| Readability above grade 12 | Flesch-Kincaid grade level > 12. Flag for content team review. |
| No internal links | Page has zero links to other pages on the same domain. |
| Missing schema markup | No JSON-LD or microdata on a page type that benefits from it (article, product, FAQ, recipe). |
| No canonical tag | `<link rel="canonical">` missing. Risk of duplicate content issues. |
| LCP > 3 seconds | Largest Contentful Paint exceeds 3s. Flag for performance review. |
| Missing OG / Twitter Card meta | No `og:title`, `og:description`, `og:image` or `twitter:card` tags. Sharing on social platforms will use fallback (often wrong). |
| Heading hierarchy broken | H3 appears before any H2, or heading levels skip (H1 -> H3). |
| Meta description length | Under 120 or over 160 characters. |
| Meta title length | Under 30 or over 60 characters. |

## Email Deliverability Track

When email content is detected, use the **email-deliverability** skill to run the full check. That skill covers:

- SpamCheck API scoring via Postmark (free, no auth)
- Blocking failure checklist (spam score, CAN-SPAM compliance, merge variables, freemail domains)
- Warning checklist (subject line quality, preview text, plain text alternative, link safety)
- SpamAssassin rule lookup table
- Reporting format

Do not duplicate the email-deliverability skill content here. Reference it and include its output in the QA comment under the Email Deliverability section.

## QA Comment Format

Structure the QA comment with up to three sections. Only include sections that apply.

```markdown
## QA Review -- [ISSUE-ID]

### Functional Testing

**Test environment:** [URL or environment description]
**Branch/commit:** [branch name or SHA]

| Test case | Steps | Expected | Actual | Status |
|-----------|-------|----------|--------|--------|
| [Name] | [Steps taken] | [Expected result] | [What happened] | PASS/FAIL |
| ... | ... | ... | ... | ... |

**Screenshot evidence:** [attached]

---

### SEO Review

**URL tested:** https://viracue.com/blog/new-article

**Blocking checks:**
- [x] Meta title present and unique ("New Article Title | Viracue")
- [x] Single H1 tag
- [x] Meta description present (142 chars)
- [x] Image alt text coverage: 8/8 (100%)
- [x] Content length: 847 words
- [x] HTTP 200, no noindex

**Warnings:**
- [ ] Missing OG image tag (`og:image` not set)
- [ ] No schema markup (Article type recommended for blog posts)
- [x] Readability: grade 9 (OK)
- [x] Internal links: 4 found
- [x] LCP: 1.8s

**SEO verdict:** PASS with 2 warnings

---

### Email Deliverability

**SpamCheck score:** 1.4 / 10.0 -- CLEAN

**Blocking checks:**
- [x] SpamAssassin score < 5.0 (1.4)
- [x] Unsubscribe link present
- [x] No broken merge variables
- [x] Text content present
- [x] From domain: notifications@viracue.com (not freemail)

**Warnings:** None

**Email verdict:** PASS

---

### Overall Verdict

QA: PASS

All functional tests passed. SEO review passed with 2 non-blocking warnings (missing OG image, no schema markup). Email deliverability clean.
```

### When only functional testing applies

If neither web-facing content nor email content is detected, use only the Functional Testing section and the Overall Verdict. Do not include empty SEO or Email sections.

### When to FAIL

Mark `QA: FAIL` if ANY of the following:
- A functional test case fails
- An SEO blocking failure is found
- An email deliverability blocking failure is found (SpamAssassin >= 5.0, missing unsubscribe, broken merge vars, image-only, freemail From)

Include the specific failure reason in the Overall Verdict section so the engineer knows exactly what to fix.
