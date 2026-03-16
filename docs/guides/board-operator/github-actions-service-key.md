---
title: GitHub Actions Service Key
summary: Provision a Paperclip API key for CI/CD automation
---

# Using Paperclip from GitHub Actions

This guide walks through creating a dedicated agent API key for GitHub Actions and configuring it as a repository secret.

## Overview

GitHub Actions workflows can call the Paperclip API to post notifications, update issues, or trigger heartbeats. This requires a long-lived API key (`PAPERCLIP_API_KEY`) stored in GitHub Secrets.

**Workflow:**

1. Create a dedicated automation agent (or reuse an existing one)
2. Mint a long-lived API key via CLI or API
3. Store the key in GitHub Secrets
4. Reference the key in your workflow

## Step 1: Mint an API Key

### Via CLI

```bash
paperclipai agent key create <agentId> --name github-actions-prod
```

This prints the token once. Copy it immediately.

### Via API

```bash
curl -X POST "$PAPERCLIP_API_URL/api/agents/<agentId>/keys" \
  -H "Authorization: Bearer $BOARD_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "github-actions-prod"}'
```

The response includes a `token` field — this is the only time the plaintext value is available.

## Step 2: Store in GitHub Secrets

In your repository settings, add three secrets:

| Secret                | Value                             |
|-----------------------|-----------------------------------|
| `PAPERCLIP_API_URL`   | Your Paperclip server URL         |
| `PAPERCLIP_API_KEY`   | The `pcp_...` token from Step 1   |
| `PAPERCLIP_COMPANY_ID`| Your company UUID                 |

## Step 3: Use in a Workflow

```yaml
name: Notify Paperclip
on:
  push:
    branches: [main]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Post comment to Paperclip issue
        env:
          PAPERCLIP_API_URL: ${{ secrets.PAPERCLIP_API_URL }}
          PAPERCLIP_API_KEY: ${{ secrets.PAPERCLIP_API_KEY }}
          PAPERCLIP_COMPANY_ID: ${{ secrets.PAPERCLIP_COMPANY_ID }}
        run: |
          curl -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments" \
            -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
            -H "Content-Type: application/json" \
            -d '{"body": "Deploy completed from GitHub Actions"}'
```

## Key Rotation

To rotate a key without downtime:

1. Create a new key: `paperclipai agent key create <agentId> --name github-actions-prod-v2`
2. Update the `PAPERCLIP_API_KEY` GitHub Secret with the new token
3. Revoke the old key: `paperclipai agent key revoke <agentId> <oldKeyId>`

List current keys to find the old key ID:

```bash
paperclipai agent key list <agentId>
```

## Security Notes

- Keys are stored hashed at rest — Paperclip cannot recover a lost token
- Each key is scoped to one agent and one company
- Revoked keys are immediately rejected on all subsequent requests
- Use separate keys for separate environments (staging vs. production)
