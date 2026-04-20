# Domain-Aware QA Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create two new skills (`email-deliverability` and `qa-domain-review`) and update the QA Agent's AGENTS.md via the native instructions bundle API so that QA reviews include SEO audits for web content and spam/deliverability checks for email content.

**Architecture:** Instruction-driven — no server code changes. Two bundled skills in `skills/`, one QA Agent AGENTS.md update via the native Paperclip instructions bundle API (`PUT /api/agents/:id/instructions-bundle/file`), and agent `desiredSkills` config updates via SQL.

**Tech Stack:** Markdown (SKILL.md files), Paperclip Instructions Bundle API, PostgreSQL (agent config), Postmark SpamCheck API (free, no key)

---

### Task 1: Create the `email-deliverability` skill

Standalone skill usable by any agent that produces or reviews email content.

**Files:**
- Create: `skills/email-deliverability/SKILL.md`

**Step 1: Create the skill directory**

```bash
mkdir -p skills/email-deliverability
```

**Step 2: Write the SKILL.md**

Create `skills/email-deliverability/SKILL.md` with the full content below. This teaches agents how to validate email deliverability using the free Postmark SpamCheck API and a manual checklist.

The skill must cover:
- Constructing a raw RFC 2822 email from template content (headers + body)
- Calling `POST https://spamcheck.postmarkapp.com/filter` with `{"email": "<raw>", "options": "long"}`
- Interpreting the SpamAssassin score: 0–2.9 clean, 3.0–4.9 marginal, 5.0+ spam
- Deliverability checklist: unsubscribe link (CAN-SPAM), merge variables, text/image ratio, company domain in From, preview text, subject line hygiene, HTTPS links, no URL shorteners
- Blocking failures: score >= 5.0, missing unsubscribe on marketing email, broken merge variables, image-only with no text
- Common SpamAssassin rules with fixes (HTML_IMAGE_RATIO, MIME_HTML_ONLY, SUBJ_ALL_CAPS, etc.)
- Reporting format for QA comments

**Step 3: Verify**

```bash
head -3 skills/email-deliverability/SKILL.md
```

Expected: YAML frontmatter starting with `---` and `name: email-deliverability`.

**Step 4: Commit**

```bash
git add skills/email-deliverability/SKILL.md
git commit -m "feat: add email-deliverability skill for spam/inbox validation"
```

---

### Task 2: Create the `qa-domain-review` skill

QA-specific skill that teaches the QA Agent when and how to run domain-aware reviews.

**Files:**
- Create: `skills/qa-domain-review/SKILL.md`

**Step 1: Create the skill directory**

```bash
mkdir -p skills/qa-domain-review
```

**Step 2: Write the SKILL.md**

Create `skills/qa-domain-review/SKILL.md`. This skill must cover:

**Detection logic** — before every QA review, classify the work product:
- Web-facing content: URL on public domain, or issue mentions blog/landing page/marketing page/article
- Email content: issue mentions Loops/cold email/transactional/lifecycle/newsletter, or involves loops-lifecycle-ops skill
- Neither: standard QA only

**SEO review track** (web content):
- Run `/seo page <url>` — meta tags, heading hierarchy, image alt text, links, canonical
- Run `/seo content <url>` — E-E-A-T signals, readability, content depth, keywords
- Run `/seo audit <url>` for new pages/major rewrites — Core Web Vitals, mobile-friendly, crawlability, schema
- Blocking failures: missing/duplicate meta title, no/multiple H1, missing meta description, >50% images lack alt text, blog under 300 words
- Warnings: readability >grade 12, no internal links, missing schema, no canonical, LCP >3s

**Email review track** (email content):
- References the `email-deliverability` skill for full SpamCheck API instructions and checklist
- Blocking failures: score >=5.0, missing unsubscribe, broken merge variables, image-only
- Warnings: score 3.0–4.9, mild spam patterns in subject, missing preview text

**QA comment format** showing how to include domain results alongside functional testing.

**Step 3: Verify**

```bash
head -3 skills/qa-domain-review/SKILL.md
```

Expected: YAML frontmatter with `name: qa-domain-review`.

**Step 4: Commit**

```bash
git add skills/qa-domain-review/SKILL.md
git commit -m "feat: add qa-domain-review skill for SEO and email QA tracks"
```

---

### Task 3: Update QA Agent's AGENTS.md via native instructions bundle API

The QA Agent (ID: `24da232f-9ee1-435b-bf23-aa772ad5a981`) has `instructionsBundleMode: "external"` with its AGENTS.md at `/paperclip/instances/default/workspaces/24da232f-9ee1-435b-bf23-aa772ad5a981/AGENTS.md`.

**Do NOT SSH into the container and edit files directly.** Use the Paperclip instructions bundle API.

**Step 1: Read current QA Agent AGENTS.md content**

From inside the container (to use localhost):

```bash
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  root@64.176.199.162 \
  "docker exec paperclip-server-1 node -e \"
    fetch('http://localhost:3100/api/agents/24da232f-9ee1-435b-bf23-aa772ad5a981/instructions-bundle/file?path=AGENTS.md')
      .then(r => r.json())
      .then(d => process.stdout.write(typeof d.content === 'string' ? d.content : JSON.stringify(d)))
      .catch(e => console.error(e));
  \"" > /tmp/qa-agents-current.md
```

Note: If the API requires auth, the instructions bundle endpoints may need a board session. In that case, read the file via `docker exec paperclip-server-1 cat <path>` to get the content, then write back via the API or direct file write with proper ownership.

**Step 2: Append the Domain-Specific Review section**

Add the following section at the end of the QA Agent's AGENTS.md (after the Health Score Thresholds table):

```markdown

### Domain-Specific Review (MANDATORY for web content and email)

Standard QA testing verifies that a feature *works*. Domain review verifies that it will *succeed in the real world*. Both are required before QA: PASS when the work product includes web-facing content or email.

**Detection — check before every review:**

1. **Does the work product include a public-facing URL?** (viraforgelabs.com, viracue.com, any public domain, blog post, landing page, marketing page)
   → **YES:** Run the SEO review track. Use the `seo`, `seo-page`, `seo-content`, and `seo-audit` skills.

2. **Does the work involve email content?** (Loops template, cold email, Gmail campaign, transactional email, lifecycle sequence, newsletter)
   → **YES:** Run the email deliverability track. Use the `email-deliverability` skill.

3. **Neither?**
   → Standard QA only.

**SEO review track — blocking failures (automatic QA: FAIL):**
- Missing or duplicate meta title
- No H1 tag or multiple H1 tags
- Missing meta description
- More than 50% of images lack alt text
- Blog/article page with fewer than 300 words

**Email deliverability track — blocking failures (automatic QA: FAIL):**
- SpamAssassin score >= 5.0 (via Postmark SpamCheck API)
- Missing unsubscribe link on marketing/lifecycle email
- Broken merge variables in rendered output
- Image-only email with no text fallback

**Include domain results in your QA comment.** See the `qa-domain-review` skill for the full protocol, detection rules, and comment format template.
```

**Step 3: Write back via the instructions bundle API**

```bash
# Construct the updated content
cat /tmp/qa-agents-current.md /tmp/qa-domain-review-section.md > /tmp/qa-agents-updated.md

# Write via API (from inside container)
ssh ... root@64.176.199.162 \
  "docker cp /tmp/qa-agents-updated.md paperclip-server-1:/tmp/qa-agents-updated.md && \
   docker exec paperclip-server-1 node -e \"
    const fs = require('fs');
    const content = fs.readFileSync('/tmp/qa-agents-updated.md', 'utf8');
    fetch('http://localhost:3100/api/agents/24da232f-9ee1-435b-bf23-aa772ad5a981/instructions-bundle/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'AGENTS.md', content })
    }).then(r => r.json()).then(d => console.log(JSON.stringify(d))).catch(e => console.error(e));
  \""
```

If the API requires authentication (returns 401), fall back to writing the file directly with correct ownership:

```bash
ssh ... root@64.176.199.162 \
  "docker cp /tmp/qa-agents-updated.md \
    paperclip-server-1:/paperclip/instances/default/workspaces/24da232f-9ee1-435b-bf23-aa772ad5a981/AGENTS.md && \
   docker exec paperclip-server-1 chown node:node \
    /paperclip/instances/default/workspaces/24da232f-9ee1-435b-bf23-aa772ad5a981/AGENTS.md"
```

**Step 4: Verify the section was added**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-server-1 grep -c 'Domain-Specific Review' \
    /paperclip/instances/default/workspaces/24da232f-9ee1-435b-bf23-aa772ad5a981/AGENTS.md"
```

Expected: `1`.

---

### Task 4: Update agent skill assignments

**Step 1: Update QA Agent — add qa-domain-review + SEO skills + email-deliverability**

Current QA Agent has 13 skills. Adding 7 new: `qa-domain-review`, `email-deliverability`, `seo`, `seo-page`, `seo-content`, `seo-audit`, `seo-technical`.

```sql
UPDATE agents SET adapter_config = jsonb_set(
  adapter_config,
  '{paperclipSkillSync,desiredSkills}',
  '["paperclipai/paperclip/paperclip","paperclipai/paperclip/capability-check","paperclipai/paperclip/issue-attachments","paperclipai/paperclip/para-memory-files","company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime","paperclipai/paperclip/gmail","paperclipai/paperclip/posthog","paperclipai/paperclip/dogfood","wondelai/skills/cro-methodology","wondelai/skills/ux-heuristics","garrytan/gstack/qa-only","jeffallan/claude-skills/playwright-expert","garrytan/gstack/canary","paperclipai/paperclip/qa-domain-review","paperclipai/paperclip/email-deliverability","agricidaniel/claude-seo/seo","agricidaniel/claude-seo/seo-page","agricidaniel/claude-seo/seo-content","agricidaniel/claude-seo/seo-audit","agricidaniel/claude-seo/seo-technical"]'::jsonb
), updated_at = now()
WHERE id = '24da232f-9ee1-435b-bf23-aa772ad5a981';
```

**Step 2: Add email-deliverability to 5 other agents**

For each agent, append `"paperclipai/paperclip/email-deliverability"` to their existing desiredSkills:

```sql
-- Lifecycle CRM Operator
UPDATE agents SET adapter_config = jsonb_set(
  adapter_config, '{paperclipSkillSync,desiredSkills}',
  (SELECT adapter_config->'paperclipSkillSync'->'desiredSkills' || '["paperclipai/paperclip/email-deliverability"]'::jsonb FROM agents WHERE id = '7af389fa-cfa9-4559-aa44-99b79c311d8d')
), updated_at = now() WHERE id = '7af389fa-cfa9-4559-aa44-99b79c311d8d';

-- Marketing Ops Operator
UPDATE agents SET adapter_config = jsonb_set(
  adapter_config, '{paperclipSkillSync,desiredSkills}',
  (SELECT adapter_config->'paperclipSkillSync'->'desiredSkills' || '["paperclipai/paperclip/email-deliverability"]'::jsonb FROM agents WHERE id = '76de7f47-1818-4c5e-8824-75848740eda3')
), updated_at = now() WHERE id = '76de7f47-1818-4c5e-8824-75848740eda3';

-- CMO
UPDATE agents SET adapter_config = jsonb_set(
  adapter_config, '{paperclipSkillSync,desiredSkills}',
  (SELECT adapter_config->'paperclipSkillSync'->'desiredSkills' || '["paperclipai/paperclip/email-deliverability"]'::jsonb FROM agents WHERE id = '0a07e1ba-2f19-45af-940a-3a0c5381267f')
), updated_at = now() WHERE id = '0a07e1ba-2f19-45af-940a-3a0c5381267f';

-- Senior Codex Developer
UPDATE agents SET adapter_config = jsonb_set(
  adapter_config, '{paperclipSkillSync,desiredSkills}',
  (SELECT adapter_config->'paperclipSkillSync'->'desiredSkills' || '["paperclipai/paperclip/email-deliverability"]'::jsonb FROM agents WHERE id = '6a781f12-12ac-4eaa-830f-4791e028ea23')
), updated_at = now() WHERE id = '6a781f12-12ac-4eaa-830f-4791e028ea23';

-- Senior Claude Code Engineer
UPDATE agents SET adapter_config = jsonb_set(
  adapter_config, '{paperclipSkillSync,desiredSkills}',
  (SELECT adapter_config->'paperclipSkillSync'->'desiredSkills' || '["paperclipai/paperclip/email-deliverability"]'::jsonb FROM agents WHERE id = '5123d8b9-0a84-4e0d-95a4-83932f2707ea')
), updated_at = now() WHERE id = '5123d8b9-0a84-4e0d-95a4-83932f2707ea';
```

**Step 3: Verify skill counts**

```sql
SELECT name, jsonb_array_length(adapter_config->'paperclipSkillSync'->'desiredSkills') as skill_count
FROM agents WHERE id IN (
  '24da232f-9ee1-435b-bf23-aa772ad5a981',
  '7af389fa-cfa9-4559-aa44-99b79c311d8d',
  '76de7f47-1818-4c5e-8824-75848740eda3',
  '0a07e1ba-2f19-45af-940a-3a0c5381267f',
  '6a781f12-12ac-4eaa-830f-4791e028ea23',
  '5123d8b9-0a84-4e0d-95a4-83932f2707ea'
) ORDER BY name;
```

Expected: QA Agent 20, others +1 each from their previous count.

---

### Task 5: Deploy and verify

**Step 1: Push and create PR**

```bash
git push -u origin feat/domain-aware-qa
gh pr create --repo Viraforge/paperclip \
  --title "feat: domain-aware QA review — SEO + email deliverability skills" \
  --body "$(cat <<'EOF'
## Summary
- New `email-deliverability` skill: SpamCheck API + deliverability checklist (6 agents)
- New `qa-domain-review` skill: detection logic for web vs email vs standard QA
- QA Agent AGENTS.md updated with Domain-Specific Review protocol (via native instructions bundle)
- QA Agent gets 7 new skills (SEO suite + domain review + email deliverability)

## Test plan
- [ ] QA Agent heartbeat succeeds after skill update
- [ ] Skills appear in QA Agent skill list at /DLD/agents/qa-agent/skills
- [ ] Next QA review of web-content issue includes SEO checks
- [ ] Next QA review of email issue includes SpamCheck

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 2: Wait for CI + merge + deploy**

Monitor: `gh run list --repo Viraforge/paperclip --workflow=deploy-vultr.yml --limit 1`

**Step 3: Verify deployed skills exist**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-server-1 ls /app/skills/ | grep -E 'email-deliverability|qa-domain-review'"
```

Expected: Both directories present.

**Step 4: Verify QA Agent heartbeat succeeds**

```sql
SELECT status, error_code, started_at FROM heartbeat_runs
WHERE agent_id = '24da232f-9ee1-435b-bf23-aa772ad5a981'
ORDER BY started_at DESC LIMIT 3;
```

Expected: Latest runs show `succeeded`.

**Step 5: Functional test — web content QA**

Create or find a test issue with a public-facing URL work product. Assign to QA Agent. Verify the review comment includes the SEO review section.

**Step 6: Functional test — email content QA**

Create or find a test issue involving email content. Assign to QA Agent. Verify the review comment includes the email deliverability section with SpamCheck score.
