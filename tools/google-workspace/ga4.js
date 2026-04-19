#!/usr/bin/env node
// GA4 Analytics CLI — reports, realtime, conversions, Measurement Protocol
// Uses GA4_ACCESS_TOKEN env var for auth (generate with gws-token.js)
// Zero external dependencies — Node.js only

const ACCESS_TOKEN = process.env.GA4_ACCESS_TOKEN;
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const MP_URL = 'https://www.google-analytics.com/mp/collect';

if (!ACCESS_TOKEN) {
  console.error(JSON.stringify({ error: 'GA4_ACCESS_TOKEN environment variable required' }));
  process.exit(1);
}

async function api(method, baseUrl, path, body) {
  if (args['dry-run']) {
    return { _dry_run: true, method, url: `${baseUrl}${path}`, body: body || undefined };
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, body: text }; }
}

async function mpApi(measurementId, apiSecret, body) {
  const params = new URLSearchParams({ measurement_id: measurementId, api_secret: apiSecret });
  if (args['dry-run']) {
    return { _dry_run: true, method: 'POST', url: `${MP_URL}?${new URLSearchParams({ measurement_id: measurementId, api_secret: '***' })}`, body };
  }
  const res = await fetch(`${MP_URL}?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!text) return { status: res.status, success: res.ok };
  try { return JSON.parse(text); } catch { return { status: res.status, body: text }; }
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { result[key] = next; i++; } else { result[key] = true; }
    } else { result._.push(arg); }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, sub] = args._;

async function main() {
  let result;
  switch (cmd) {
    case 'reports':
      if (sub === 'run') {
        const property = args.property;
        if (!property) { result = { error: '--property required' }; break; }
        const body = { dateRanges: [{ startDate: args['start-date'] || '30daysAgo', endDate: args['end-date'] || 'today' }] };
        if (args.dimensions) body.dimensions = args.dimensions.split(',').map(d => ({ name: d.trim() }));
        if (args.metrics) body.metrics = args.metrics.split(',').map(m => ({ name: m.trim() }));
        result = await api('POST', DATA_API, `/properties/${property}:runReport`, body);
      } else { result = { error: 'Use: reports run' }; }
      break;
    case 'realtime':
      if (sub === 'run') {
        const property = args.property;
        if (!property) { result = { error: '--property required' }; break; }
        const body = {};
        if (args.dimensions) body.dimensions = args.dimensions.split(',').map(d => ({ name: d.trim() }));
        if (args.metrics) body.metrics = args.metrics.split(',').map(m => ({ name: m.trim() }));
        result = await api('POST', DATA_API, `/properties/${property}:runRealtimeReport`, body);
      } else { result = { error: 'Use: realtime run' }; }
      break;
    case 'conversions':
      if (sub === 'list') {
        if (!args.property) { result = { error: '--property required' }; break; }
        result = await api('GET', ADMIN_API, `/properties/${args.property}/conversionEvents`);
      } else if (sub === 'create') {
        if (!args.property || !args['event-name']) { result = { error: '--property and --event-name required' }; break; }
        result = await api('POST', ADMIN_API, `/properties/${args.property}/conversionEvents`, { eventName: args['event-name'] });
      } else { result = { error: 'Use: conversions list|create' }; }
      break;
    case 'events':
      if (sub === 'send') {
        if (!args['measurement-id'] || !args['api-secret'] || !args['client-id'] || !args['event-name']) {
          result = { error: '--measurement-id, --api-secret, --client-id, --event-name required' }; break;
        }
        let eventParams = {};
        if (args.params) { try { eventParams = JSON.parse(args.params); } catch { result = { error: 'Invalid JSON in --params' }; break; } }
        result = await mpApi(args['measurement-id'], args['api-secret'], {
          client_id: args['client-id'], events: [{ name: args['event-name'], params: eventParams }]
        });
      } else { result = { error: 'Use: events send' }; }
      break;
    default:
      result = { usage: {
        reports: 'reports run --property <id> [--start-date <date>] [--end-date <date>] [--dimensions <dims>] [--metrics <metrics>]',
        realtime: 'realtime run --property <id> [--dimensions <dims>] [--metrics <metrics>]',
        conversions: 'conversions [list|create] --property <id> [--event-name <name>]',
        events: 'events send --measurement-id <id> --api-secret <secret> --client-id <id> --event-name <name> [--params <json>]',
      }};
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
