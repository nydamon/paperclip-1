---
name: acceptance-configs
description: Use when authoring acceptance specs for configuration-file deliverables (YAML workflows, docker-compose, .env files, static JSON configs). One JSON spec per issue at tests/<DLD-XXXX>.config.spec.json, consumed by the verification worker's config-runner.
---

# Config Acceptance Specs

## When to use

Backend QA Agent, assigned an issue with `deliverable_type: config`. Write a JSON spec at `skills/acceptance-configs/tests/<DLD-XXXX>.config.spec.json` before the engineer starts. The verification worker reads the target config file, parses it, and validates it against a schema (json/yaml) or required key set (env).

## Spec format (JSON config)

```json
{
  "configPath": "server/tsconfig.json",
  "format": "json",
  "expectedSchema": {
    "type": "object",
    "required": ["compilerOptions"],
    "properties": {
      "compilerOptions": {
        "type": "object",
        "required": ["strict", "target"],
        "properties": {
          "strict": { "const": true },
          "target": { "type": "string", "pattern": "^(ES2022|ESNext)$" }
        }
      }
    }
  },
  "notContains": ["TODO", "skipLibCheck: true"]
}
```

## Spec format (YAML workflow)

```yaml
{
  "configPath": ".github/workflows/deploy-vultr.yml",
  "format": "yaml",
  "expectedSchema": {
    "type": "object",
    "required": ["name", "on", "jobs"],
    "properties": {
      "jobs": {
        "type": "object",
        "required": ["build-and-push"]
      }
    }
  }
}
```

## Spec format (env file)

```json
{
  "configPath": ".env.example",
  "format": "env",
  "requiredKeys": [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "PAPERCLIP_PUBLIC_URL"
  ],
  "notContains": ["password123", "secret_here"]
}
```

## Fields

| Field | Type | Required | Purpose |
|---|---|---|---|
| `configPath` | string | yes | Relative path under repo root (no `..`, no leading `/`) |
| `format` | "json" \| "yaml" \| "env" | yes | How to parse the target file |
| `expectedSchema` | JSON Schema | no (not for env) | ajv-compatible schema to validate parsed content |
| `requiredKeys` | string[] | yes for env | Env variable names that must be present |
| `notContains` | string[] | no | Substrings that must NOT appear in raw file text |

## Quality rules

1. **At least 3 assertions.** A schema with multiple `required` fields counts as multiple; one `requiredKeys` array with multiple entries counts as multiple.
2. **No wildcard schemas.** `{ "type": "object" }` alone is rejected as trivially satisfied.
3. **Literal reference to the deliverable target.** `configPath` must match the file path from the issue's `verification_target`.
4. **env specs need `requiredKeys` ≥ 1** — no trivially-empty env check.

## Security guardrails

- `configPath` is checked against path traversal (no `..`, no leading `/`)
- Resolved path must stay inside the repo root (double-checked after resolve)
- YAML parsing uses `js-yaml` with default safe load (no arbitrary code execution)

## Reference example — validate docker-compose.vps.yml has required services

```json
{
  "configPath": "docker-compose.vps.yml",
  "format": "yaml",
  "expectedSchema": {
    "type": "object",
    "required": ["services", "volumes"],
    "properties": {
      "services": {
        "type": "object",
        "required": ["server", "db", "edge"]
      }
    }
  },
  "notContains": ["image: latest", "TODO"]
}
```
