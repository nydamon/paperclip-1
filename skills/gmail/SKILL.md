---
name: gmail
description: "Search, read, send emails, create drafts, and manage labels via Gmail API. Use when asked to check email, send email, create drafts, search inbox, or manage labels. Works with hello@viraforgelabs.com and damon@viraforgelabs.com."
---

# Gmail

Full Gmail integration via service account DWD. No browser auth needed.

**Mailbox:** damon@viraforgelabs.com
**Send-as alias:** hello@viraforgelabs.com (set --from to use)

## Commands

All operations via `node /paperclip/bin/gmail.js`. Auth is automatic from env vars.

### Search emails
```bash
node /paperclip/bin/gmail.js search "from:someone@example.com is:unread"
node /paperclip/bin/gmail.js search --limit 20
node /paperclip/bin/gmail.js search "newer_than:7d" --label INBOX --limit 10
node /paperclip/bin/gmail.js search "subject:important" --include-spam-trash
```

### Read email
```bash
node /paperclip/bin/gmail.js get MESSAGE_ID
node /paperclip/bin/gmail.js get MESSAGE_ID --format metadata
node /paperclip/bin/gmail.js get MESSAGE_ID --format minimal
```

### Send email
```bash
node /paperclip/bin/gmail.js send --to "user@example.com" --subject "Hello" --body "Message body"
node /paperclip/bin/gmail.js send --to "user@example.com" --subject "Hello" --body "Message" --from "hello@viraforgelabs.com"
node /paperclip/bin/gmail.js send --to "user@example.com" --cc "cc@example.com" --subject "Update" --body "Content" --html
```

### Drafts
```bash
node /paperclip/bin/gmail.js create-draft --to "user@example.com" --subject "Draft" --body "Content"
node /paperclip/bin/gmail.js send-draft DRAFT_ID
```

### Modify messages (labels)
```bash
node /paperclip/bin/gmail.js modify MESSAGE_ID --remove-label UNREAD      # mark read
node /paperclip/bin/gmail.js modify MESSAGE_ID --remove-label INBOX       # archive
node /paperclip/bin/gmail.js modify MESSAGE_ID --add-label STARRED        # star
node /paperclip/bin/gmail.js modify MESSAGE_ID --add-label IMPORTANT      # mark important
```

### List labels
```bash
node /paperclip/bin/gmail.js list-labels
```

## Gmail query syntax

| Query | Description |
|-------|-------------|
| `from:user@example.com` | From specific sender |
| `to:user@example.com` | To specific recipient |
| `subject:meeting` | Subject contains |
| `is:unread` | Unread emails |
| `is:starred` | Starred emails |
| `has:attachment` | Has attachments |
| `newer_than:7d` | Last 7 days |
| `older_than:1m` | Older than 1 month |
| `label:work` | Specific label |
| `in:inbox` / `in:sent` | Location |

Combine: `from:boss@company.com is:unread newer_than:1d`

## Common label IDs

INBOX, SENT, DRAFT, SPAM, TRASH, STARRED, IMPORTANT, UNREAD

## Output

All output is JSON.
