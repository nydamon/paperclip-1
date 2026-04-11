---
name: email-deliverability
description: Validate email deliverability before sending. Checks spam score via Postmark SpamCheck API, evaluates content for spam triggers, and runs a CAN-SPAM compliance checklist. Use when creating, reviewing, or QA-testing email campaigns, transactional emails, cold outreach, or lifecycle sequences.
---

# Email Deliverability

Validate that an email will reach the inbox, not the spam folder. This skill covers spam scoring via Postmark's free SpamCheck API, a blocking/warning deliverability checklist, and a reporting format for QA comments.

## SpamCheck API (Postmark)

Postmark provides a free, no-auth endpoint that runs SpamAssassin against a raw email and returns a score plus matched rules.

### Construct a raw RFC 2822 email

SpamCheck expects a complete RFC 2822 message. Build it as a string:

```bash
RAW_EMAIL=$(cat <<'EOEML'
From: notifications@yourdomain.com
To: test@example.com
Subject: Your weekly summary is ready
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<html>
<body>
  <h1>Weekly Summary</h1>
  <p>Here is your report for this week.</p>
  <p><a href="https://yourdomain.com/unsubscribe">Unsubscribe</a></p>
</body>
</html>
EOEML
)
```

Key header requirements:
- **From** must be a real domain you control (not gmail.com, yahoo.com, etc.)
- **MIME-Version** and **Content-Type** are required for HTML emails
- Include the actual body content you plan to send -- the scorer evaluates everything

### Send to SpamCheck

```bash
RESPONSE=$(curl -s -X POST https://spamcheck.postmarkapp.com/filter \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg email "$RAW_EMAIL" '{email: $email, options: "long"}')")

echo "$RESPONSE" | jq '{score: .score, success: .success, rules: [.rules[] | {score: .score, description: .description}]}'
```

No API key needed. The `"options": "long"` flag returns the full rule breakdown instead of just the score.

### Score thresholds

| Score range | Verdict | Action |
|-------------|---------|--------|
| **0.0 -- 2.9** | Clean | Ship it. Low risk of spam filtering. |
| **3.0 -- 4.9** | Marginal | Review the matched rules. Fix anything easy. Retest. |
| **5.0+** | Will be spam-filtered | Do NOT send. Fix all high-weight rules and retest until below 3.0. |

## Deliverability Checklist

### Blocking failures (must fix before sending)

These are hard stops. Any one of these means the email will fail delivery or violate regulations:

| Check | Why it blocks |
|-------|---------------|
| SpamAssassin score >= 5.0 | Most providers filter at 5.0. Gmail and Outlook often filter at lower thresholds. |
| Missing unsubscribe link on marketing/lifecycle email | CAN-SPAM Act requires a visible, functional unsubscribe mechanism in every commercial email. Transactional emails (password resets, order confirmations) are exempt. |
| Broken merge variables (raw `{{name}}`, `{{company}}`, `%FNAME%` in output) | Template variables not replaced indicate a broken template pipeline. Recipients see literal placeholder text. |
| Image-only email with no text fallback | Many clients block images by default. An image-only email renders as a blank white rectangle. Always include text content. |
| From address uses freemail domain (gmail.com, yahoo.com, hotmail.com, outlook.com, aol.com) | DMARC policies on freemail domains cause hard failures when sent from third-party infrastructure. Use a domain you control with proper SPF/DKIM/DMARC. |

### Warnings (should fix, not blocking)

These degrade deliverability or engagement but are not immediate deal-breakers:

| Check | Impact |
|-------|--------|
| Score 3.0--4.9 with specific rules | Marginal. Review each rule and fix what you can. |
| Subject line: ALL CAPS | Triggers SUBJ_ALL_CAPS rule. Reduces open rates even when it lands in inbox. |
| Subject line: excessive punctuation (!!!, ???, $$$) | Triggers SpamAssassin punctuation rules. Looks unprofessional. |
| Subject line: spam trigger words (FREE, ACT NOW, LIMITED TIME, URGENT, WINNER, CONGRATULATIONS) | Individual words may not trigger alone, but combinations stack. Rewrite to be specific. |
| Missing preview/preheader text | The gray text after the subject in inbox view. Without it, clients show the first body text (often "View in browser" or navigation links). |
| No plain text alternative for HTML emails | Some clients and all accessibility tools prefer plain text. Use `multipart/alternative` with both versions. |
| HTTP links (not HTTPS) | Mixed content warnings. Some clients flag HTTP links as insecure. Always use HTTPS. |
| URL shorteners (bit.ly, t.co, tinyurl.com, ow.ly) | Heavily associated with phishing. Use full URLs from your own domain. |
| Missing Reply-To header | Without Reply-To, replies go to the From address. If From is a no-reply address, the recipient's reply vanishes silently. |

## Common SpamAssassin Rules

When SpamCheck returns matched rules, use this table to understand and fix them:

| Rule | Score | What it means | Fix |
|------|-------|---------------|-----|
| `HTML_IMAGE_RATIO_02` | 1.5--2.0 | Images make up more than 80% of the email body vs text | Add more text content. Aim for at least 60% text / 40% images. |
| `MIME_HTML_ONLY` | 0.7--1.0 | HTML email with no plain text alternative | Add a `text/plain` MIME part using `multipart/alternative`. |
| `SUBJ_ALL_CAPS` | 1.0--1.5 | Subject line is entirely uppercase | Use sentence case or title case. |
| `LOTS_OF_MONEY` | 1.0--2.0 | Body mentions large dollar amounts ($$$, millions, etc.) | Rewrite to avoid hyperbolic financial claims. |
| `FUZZY_CREDIT` | 1.0--2.0 | Body text resembles credit card / financial solicitation | Remove or rephrase financial language. |
| `HTML_SHORT_LINK_IMG` | 1.0--1.5 | Image wrapped in a short URL redirect | Use full destination URLs from your own domain. |
| `MISSING_MID` | 0.5--1.0 | Missing Message-ID header | Add a `Message-ID: <unique-id@yourdomain.com>` header. Most sending libraries do this automatically. |
| `MISSING_DATE` | 1.0 | Missing Date header | Add a `Date:` header. Sending libraries usually handle this. |
| `HTML_FONT_LOW_CONTRAST` | 0.5--1.0 | Text color too close to background color | Ensure sufficient contrast (WCAG AA minimum). |
| `URIBL_BLOCKED` | 0.0 | URI blocklist lookup failed (not necessarily bad) | Usually benign in test environments. Verify your domain is not on URI blocklists in production. |

## Reporting Format

When reporting deliverability results in a QA comment or review, use this structure:

```markdown
### Email Deliverability

**SpamCheck score:** 2.1 / 10.0 -- CLEAN

**Blocking checks:**
- [x] SpamAssassin score < 5.0 (2.1)
- [x] Unsubscribe link present
- [x] No broken merge variables
- [x] Text content present (not image-only)
- [x] From domain is not freemail (notifications@yourdomain.com)

**Warnings:**
- [ ] Missing plain text alternative (MIME_HTML_ONLY, +0.7)
- [x] Subject line OK (no ALL CAPS, no spam triggers)
- [x] All links HTTPS
- [x] No URL shorteners
- [x] Reply-To header present

**SpamAssassin rules matched:**
| Rule | Score | Fix |
|------|-------|-----|
| MIME_HTML_ONLY | +0.7 | Add text/plain MIME part |
| HTML_IMAGE_RATIO_02 | +1.4 | Add more text content |

**Verdict:** PASS with 1 warning (add plain text alternative)
```

Adjust the checklist to show only relevant items. If all blocking checks pass and all warnings are clear, a short summary is sufficient:

```markdown
### Email Deliverability

**SpamCheck score:** 0.8 / 10.0 -- CLEAN
**All blocking checks passed. No warnings.**
```

## Full Example: Test an HTML Email

```bash
# 1. Build the raw email
RAW_EMAIL=$(cat <<'EOEML'
From: hello@viracue.com
To: test@example.com
Reply-To: support@viracue.com
Subject: Your trial expires in 3 days
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="boundary123"

--boundary123
Content-Type: text/plain; charset=UTF-8

Your trial expires in 3 days. Log in to upgrade: https://viracue.com/billing

To unsubscribe: https://viracue.com/unsubscribe

--boundary123
Content-Type: text/html; charset=UTF-8

<html>
<body>
  <h1>Your trial expires in 3 days</h1>
  <p>Log in to <a href="https://viracue.com/billing">upgrade your plan</a>.</p>
  <p style="font-size:12px;color:#666;">
    <a href="https://viracue.com/unsubscribe">Unsubscribe</a>
  </p>
</body>
</html>
--boundary123--
EOEML
)

# 2. Score it
curl -s -X POST https://spamcheck.postmarkapp.com/filter \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg email "$RAW_EMAIL" '{email: $email, options: "long"}')" | jq .

# 3. Check the score and rules, then fill in the reporting format above
```
