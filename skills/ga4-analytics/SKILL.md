---
name: ga4-analytics
description: "Query Google Analytics 4 data — reports, realtime, conversions, and Measurement Protocol events. Use when asked about traffic, sessions, users, pageviews, conversions, or any GA4 metric."
---

# GA4 Analytics

Query viracue.ai Google Analytics 4 data using CLI tools in /paperclip/bin/.

## Prerequisites

These env vars are injected at runtime:
- GWS_SERVICE_ACCOUNT_JSON — Google service account key (secret_ref)
- GWS_SUBJECT_EMAIL — impersonation target (damon@viraforgelabs.com)
- GA4_PROPERTY_ID — GA4 property (531826659)

## Step 1: Get an access token

```bash
export GA4_ACCESS_TOKEN=$(node /paperclip/bin/gws-token.js "https://www.googleapis.com/auth/analytics.readonly")
```

The token is valid for 60 minutes. Generate a new one each heartbeat.

## Step 2: Query GA4

### Standard report
```bash
GA4_ACCESS_TOKEN=$GA4_ACCESS_TOKEN node /paperclip/bin/ga4.js reports run \
  --property $GA4_PROPERTY_ID \
  --metrics sessions,totalUsers,screenPageViews \
  --dimensions sessionSource \
  --start-date 30daysAgo --end-date today
```

### Realtime
```bash
GA4_ACCESS_TOKEN=$GA4_ACCESS_TOKEN node /paperclip/bin/ga4.js realtime run \
  --property $GA4_PROPERTY_ID --metrics activeUsers
```

### List conversions
```bash
GA4_ACCESS_TOKEN=$GA4_ACCESS_TOKEN node /paperclip/bin/ga4.js conversions list \
  --property $GA4_PROPERTY_ID
```

### Send event (Measurement Protocol)
```bash
GA4_ACCESS_TOKEN=$GA4_ACCESS_TOKEN node /paperclip/bin/ga4.js events send \
  --measurement-id G-XXXXXXXXXX --api-secret <secret> \
  --client-id <id> --event-name page_view --params "{}"
```

## Common metrics

- sessions, totalUsers, newUsers, activeUsers
- screenPageViews, eventCount, conversions
- bounceRate, averageSessionDuration, engagedSessions
- userEngagementDuration, engagementRate

## Common dimensions

- sessionSource, sessionMedium, sessionCampaignName
- pagePath, pageTitle, landingPage
- country, city, deviceCategory, operatingSystem
- date, dateHour, dayOfWeek

## Dry run

Add --dry-run to any command to see the request without executing it.

## Output

All output is JSON. Parse with jq or read directly.
