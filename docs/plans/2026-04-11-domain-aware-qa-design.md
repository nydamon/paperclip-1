# Domain-Aware QA Review: SEO + Email Deliverability

**Date:** 2026-04-11
**Status:** Approved
**Scope:** 2 new skills, 1 AGENTS.md update, agent skill assignments

---

## Problem

QA reviews are functionally correct but domain-blind. The QA Agent checks whether a feature works, has no console errors, and produces screenshots — but doesn't evaluate whether the work succeeds at its domain purpose:

- **Blog posts** ship QA: PASS but have missing meta tags, no heading hierarchy, thin content, no schema markup. They won't rank.
- **Email campaigns** ship QA: PASS but trigger SpamAssassin rules, land in spam folders, lack unsubscribe links, or have broken merge variables. They won't be delivered.

The gap: QA validates "does it work?" but not "will it work in the real world?"

## Design

### Three review tracks

The QA Agent's review becomes context-sensitive based on work product type:

| Work product type | Detection | QA review includes |
|---|---|---|
| **Web-facing content** | URL on viraforgelabs.com, viracue.com, or any public domain | Standard QA + SEO audit |
| **Email content** | Issue involves Loops templates, cold email, Gmail campaigns, transactional email | Standard QA + email deliverability check |
| **Everything else** | Default | Standard QA only (current behavior) |

### Two new skills

#### Skill 1: `email-deliverability`

Standalone skill usable by any agent (not QA-specific). Teaches:

**SpamCheck API call:**
- Construct a raw email (headers + body) from the template/draft content
- POST to `https://spamcheck.postmarkapp.com/filter` with `{"email": "<raw>", "options": "long"}`
- Parse the score and matched SpamAssassin rules
- Score thresholds: 0–2.9 = clean, 3.0–4.9 = marginal (review flagged rules), 5.0+ = will be spam-filtered

**Deliverability checklist:**
- Subject line: Not ALL CAPS, no excessive punctuation, no spam trigger words
- From address: Uses company domain (not gmail.com/yahoo.com)
- Unsubscribe link: Present for marketing/lifecycle emails (CAN-SPAM compliance)
- HTML structure: Valid, not image-only, reasonable text/image ratio
- Personalization: Merge variables render correctly (no broken `{{name}}` in output)
- Preview text: Set and meaningful (not "View in browser")
- Reply-to: Set and valid
- Plain text alternative: Present for HTML emails

**Blocking failures (any agent):**
- SpamAssassin score >= 5.0
- Missing unsubscribe link on marketing email
- Broken merge variables in rendered output
- Image-only email with no text fallback

**Warnings (note but don't block):**
- Score 3.0–4.9 with specific rules flagged
- Subject line contains mild spam patterns
- Missing preview/preheader text

**Assigned to:** QA Agent, Lifecycle CRM Operator, Marketing Ops Operator, CMO, Senior Codex Developer, Senior Claude Code Engineer

#### Skill 2: `qa-domain-review`

QA-specific skill that teaches the QA Agent when and how to run domain-aware reviews. References the `email-deliverability` skill and the existing `agricidaniel/claude-seo/*` skills.

**Detection logic (in QA Agent's review workflow):**

```
Before posting QA: PASS, check:

1. Does this issue's work product include a public-facing URL?
   → YES: Run SEO review track

2. Does this issue involve email content (Loops template, cold email,
   Gmail campaign, transactional email, email HTML)?
   → YES: Run email deliverability track

3. Neither?
   → Standard QA only
```

**SEO review track (references existing SEO skills):**
- Run `/seo page <url>` — meta tags, heading hierarchy, image alt text, links
- Run `/seo content <url>` — E-E-A-T, readability, content depth, keyword presence
- Run `/seo audit <url>` for new pages or major rewrites — full technical SEO

SEO blocking failures:
- Missing or duplicate meta title
- No H1 tag, or multiple H1s
- Missing meta description
- Images without alt text (>50% of images)
- Content under 300 words on blog/article page

SEO warnings:
- Readability above grade 12
- No internal links to other site pages
- Missing schema markup
- No canonical tag
- Slow page load (>3s LCP)

**Email review track (references email-deliverability skill):**
- Construct raw email from template content
- Run SpamCheck API call
- Run deliverability checklist
- Apply score thresholds

**QA comment format for domain reviews:**

```
## QA: PASS

### Functional Testing
- [x] Feature works end-to-end
- [x] No console errors
- [x] Screenshot attached

### SEO Review (if applicable)
- [x] /seo page: Meta title present, H1 valid, alt text coverage OK
- [x] /seo content: Readability grade 8, E-E-A-T signals present
- Score: 82/100
- Warnings: No schema markup (Article type recommended)

### Email Deliverability (if applicable)
- [x] SpamCheck score: 1.8 (clean)
- [x] Unsubscribe link present
- [x] Merge variables render correctly
- [x] Preview text set
- Warnings: None
```

### Agent skill assignments

**New skill → agent mapping:**

| Skill | Agents |
|---|---|
| `qa-domain-review` | QA Agent only |
| `email-deliverability` | QA Agent, Lifecycle CRM Operator, Marketing Ops Operator, CMO, Senior Codex Developer, Senior Claude Code Engineer |

**SEO skills added to QA Agent** (already exist in company_skills, just need to be added to desiredSkills):
- `agricidaniel/claude-seo/seo`
- `agricidaniel/claude-seo/seo-page`
- `agricidaniel/claude-seo/seo-content`
- `agricidaniel/claude-seo/seo-audit`
- `agricidaniel/claude-seo/seo-technical`

### AGENTS.md update

Add a "Domain-Specific Review" section to the QA Approval Protocol in `server/src/onboarding-assets/default/AGENTS.md`, after the Interactive Testing section. This instructs all QA-capable agents (not just the QA Agent) about when domain reviews apply.

### What changes

- Create: `skills/email-deliverability/SKILL.md`
- Create: `skills/qa-domain-review/SKILL.md`
- Modify: `server/src/onboarding-assets/default/AGENTS.md` — add Domain-Specific Review section
- DB: Update 6 agents' `desiredSkills` (QA Agent + 5 email-producing agents)

### What doesn't change

- No server code changes. No new gates. No new DB columns.
- The existing QA: PASS/FAIL pattern stays. Domain review is part of what QA evaluates before posting that verdict.
- The evidence gates (screenshots, browse commands) are unchanged.
- No new API keys needed — SpamCheck is free and unauthenticated.

### Testing

1. Create a test blog post issue, assign to QA — verify QA Agent runs SEO checks before PASS
2. Create a test email campaign issue, assign to QA — verify QA Agent runs SpamCheck before PASS
3. Create a non-web, non-email issue — verify QA Agent does standard review only (no SEO/email)
4. Have Lifecycle CRM Operator self-check an email draft — verify they use email-deliverability skill before submitting for review
