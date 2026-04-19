# Loops API + Documentation Reference

## Primary documentation

- API reference index: https://loops.so/docs/api-reference
- Create contact: https://loops.so/docs/api-reference/create-contact
- Transactional email docs: https://loops.so/docs/transactional
- Quickstart (domain, audience, loops): https://loops.so/docs/quickstart
- Sending domain setup: https://loops.so/docs/sending-domain
- Subdomain guidance: https://loops.so/docs/deliverability/sending-from-subdomain

## Core API base and auth

- Base URL: `https://app.loops.so/api/v1`
- Auth: `Authorization: Bearer <LOOPS_API_KEY>`
- Header: `Content-Type: application/json`

## Frequently used endpoints (verify in docs before use)

- `POST /contacts/create` — create contact
- `POST /transactional` — send transactional email

## Lookup protocol for unknowns

When the skill does not cover a field/endpoint edge case:

1. Search Loops docs for the exact endpoint/feature.
2. Read endpoint request/response requirements.
3. Run a minimal test call.
4. Capture status code + response body (redacted) for proof.
5. Document result with URL citation.

## Security reminders

- Never post API keys in comments, logs, or screenshots.
- Use env vars / secret manager only.
- Share only redacted payload examples in task updates.
