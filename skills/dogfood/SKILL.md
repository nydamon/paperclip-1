---
name: dogfood
description: Systematically explore and test a web application to find bugs, UX issues, and other problems. Use when asked to "dogfood", "QA", "exploratory test", "find issues", "bug hunt", "test this app/site/platform", or review the quality of a web application. Produces a structured report with reproduction evidence -- DOM snapshots, console output, and detailed repro steps for every issue -- so findings can be handed directly to the responsible teams.
---

# Dogfood

Systematically explore a web application, find issues, and produce a report with reproduction evidence for every finding.

## Setup

Only the **Target URL** is required. Everything else has sensible defaults -- use them unless the user explicitly provides an override.

| Parameter | Default | Example override |
|-----------|---------|-----------------|
| **Target URL** | _(required)_ | `http://64.176.199.162:3100`, `https://example.com` |
| **Output directory** | `./dogfood-output/` | `Output directory: /tmp/qa` |
| **Scope** | Full app | `Focus on the billing page` |
| **Authentication** | None | `Sign in as user@example.com` |

If the user says something like "dogfood the app", start immediately with defaults. Do not ask clarifying questions unless authentication is mentioned but credentials are missing.

## Browser Testing Environment

All browser testing is done via the **Browser Testing VPS** over SSH. Connection details come from environment variables:

```bash
SSH_CMD="ssh -i $BROWSER_TEST_SSH_KEY -o StrictHostKeyChecking=no $BROWSER_TEST_USER@$BROWSER_TEST_HOST"
```

**Available commands:**

| Command | Purpose |
|---------|---------|
| `$SSH_CMD 'browser-test headless <url>'` | Fetch rendered HTML (after JS execution) |
| `$SSH_CMD 'DISPLAY=:99 /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome --headless --no-sandbox --disable-gpu --dump-dom <url>'` | Raw DOM dump |
| `$SSH_CMD 'browser-test headed <url>'` | Headed test (requires VNC) |

## Workflow

```
1. Initialize    Set up output dirs, report file, verify browser access
2. Orient        Load the target, take initial DOM snapshot
3. Explore       Systematically visit pages and test features
4. Document      Capture DOM evidence for each issue as found
5. Wrap up       Update summary counts, present findings
```

### 1. Initialize

```bash
mkdir -p {OUTPUT_DIR}/snapshots
```

Copy the report template into the output directory and fill in the header fields:

```bash
cp {SKILL_DIR}/templates/dogfood-report-template.md {OUTPUT_DIR}/report.md
```

Verify browser access:

```bash
ssh -i $BROWSER_TEST_SSH_KEY -o StrictHostKeyChecking=no $BROWSER_TEST_USER@$BROWSER_TEST_HOST \
  'browser-test headless {TARGET_URL}' | head -20
```

### 2. Orient

Take an initial DOM snapshot to understand the app structure:

```bash
ssh -i $BROWSER_TEST_SSH_KEY -o StrictHostKeyChecking=no $BROWSER_TEST_USER@$BROWSER_TEST_HOST \
  'browser-test headless {TARGET_URL}' > {OUTPUT_DIR}/snapshots/initial.html
```

Review the HTML output. Identify the main navigation elements and map out the sections to visit.

### 3. Explore

Read [references/issue-taxonomy.md](references/issue-taxonomy.md) for the full list of what to look for and the exploration checklist.

**Strategy -- work through the app systematically:**

- Start from the main navigation. Visit each top-level section.
- Within each section, examine rendered DOM for interactive elements: buttons, forms, links, dropdowns.
- Check edge cases: empty states, error messages, missing elements.
- Try realistic end-to-end workflows by examining the DOM state at each step.
- Look for console errors, failed requests, and rendering anomalies in the HTML output.

**At each page:**

```bash
# Rendered HTML snapshot
ssh -i $BROWSER_TEST_SSH_KEY -o StrictHostKeyChecking=no $BROWSER_TEST_USER@$BROWSER_TEST_HOST \
  'browser-test headless {URL}' > {OUTPUT_DIR}/snapshots/{page-name}.html

# Check for error elements, broken links, missing content
grep -i "error\|404\|not found\|undefined\|null" {OUTPUT_DIR}/snapshots/{page-name}.html
```

### 4. Document Issues (Repro-First)

Steps 3 and 4 happen together -- explore and document in a single pass. When you find an issue, stop exploring and document it immediately before moving on.

Every issue must have evidence. When you find something wrong, capture the DOM state that proves it.

**For each issue found:**

1. **Capture the DOM evidence** showing the problem:

```bash
ssh -i $BROWSER_TEST_SSH_KEY -o StrictHostKeyChecking=no $BROWSER_TEST_USER@$BROWSER_TEST_HOST \
  'browser-test headless {URL}' > {OUTPUT_DIR}/snapshots/issue-{NNN}.html
```

2. **Extract the relevant snippet** from the HTML showing the bug.

3. **Upload screenshot evidence to the issue** (required for evidence gates):

```bash
# Download screenshot from Browser Testing VPS
scp -i $BROWSER_TEST_SSH_KEY -o StrictHostKeyChecking=no \
  $BROWSER_TEST_USER@$BROWSER_TEST_HOST:/tmp/screenshot.png {OUTPUT_DIR}/snapshots/issue-{NNN}.png

# Upload as attachment (returns JSON with contentPath for markdown embedding)
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$ISSUE_ID/attachments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -F "file=@{OUTPUT_DIR}/snapshots/issue-{NNN}.png"
```

4. **Append to the report immediately.** Do not batch issues for later. Write each one as you find it so nothing is lost if the session is interrupted.

5. **Increment the issue counter** (ISSUE-001, ISSUE-002, ...).

### 5. Wrap Up

Aim to find **5-10 well-documented issues**, then wrap up. Quality of evidence matters more than total count -- 5 issues with clear DOM evidence beats 20 with vague descriptions.

After exploring:

1. Re-read the report and update the summary severity counts so they match the actual issues.
2. Tell the user the report is ready and summarize findings: total issues, breakdown by severity, and the most critical items.

## Guidance

- **Evidence is everything.** Every issue needs proof -- a DOM snippet, an error string, a missing element.
- **Verify before documenting.** Before writing up an issue, verify it's consistent across at least one retry. Transient network hiccups are not bugs.
- **Write findings incrementally.** Append each issue to the report as you discover it. If the session is interrupted, findings are preserved.
- **Be thorough but use judgment.** You are not following a test script -- you are exploring like a real user would. If something feels off, investigate.
- **Check for errors in the DOM.** Many issues are invisible in the rendered UI but show up as error elements, empty containers, or console error traces in the HTML.
- **Test like a user, not a robot.** Try common workflows end-to-end. Follow the paths a real user would take. Enter realistic data in forms.
- **Never read the target app's source code.** You are testing as a user, not auditing code. All findings must come from what you observe in the rendered output.
- **Never delete output files.** Do not remove snapshots or the report mid-session. Work forward, not backward.

## References

| Reference | When to Read |
|-----------|--------------|
| [references/issue-taxonomy.md](references/issue-taxonomy.md) | Start of session -- calibrate what to look for, severity levels, exploration checklist |

## Templates

| Template | Purpose |
|----------|---------|
| [templates/dogfood-report-template.md](templates/dogfood-report-template.md) | Copy into output directory as the report file |
