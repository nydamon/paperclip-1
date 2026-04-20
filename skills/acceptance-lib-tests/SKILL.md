---
name: acceptance-lib-tests
description: Use when authoring acceptance specs for library/package deliverables (lib_backend, lib_frontend). One JSON spec per issue at tests/<DLD-XXXX>.lib.spec.json, pointing to a vitest test file that the verification worker runs via the vitest-runner.
---

# Library Acceptance Specs

## When to use

QA Agent (Backend for `lib_backend`, Frontend for `lib_frontend`), assigned an issue whose deliverable is a package change with no direct URL surface. Write both:

1. A JSON spec at `skills/acceptance-lib-tests/tests/<DLD-XXXX>.lib.spec.json` that points to…
2. A vitest test file at `skills/acceptance-lib-tests/tests/<DLD-XXXX>.lib.test.ts` that imports from the target package and asserts the expected behavior.

The verification worker execs `vitest run <test-file>` in the server container, parses the JSON reporter output, and returns passed if all tests pass.

## Spec format (JSON pointer)

```json
{
  "testFile": "skills/acceptance-lib-tests/tests/DLD-1234.lib.test.ts",
  "targetPackage": "@paperclipai/adapter-utils",
  "timeoutMs": 60000
}
```

## Test file format (vitest)

```typescript
// skills/acceptance-lib-tests/tests/DLD-1234.lib.test.ts
import { describe, it, expect } from "vitest";
import { specificFunction } from "@paperclipai/adapter-utils";

describe("DLD-1234: specificFunction behavior after refactor", () => {
  it("returns 42 when given no input", () => {
    expect(specificFunction()).toBe(42);
  });

  it("handles null gracefully", () => {
    expect(specificFunction(null)).toBe(42);
  });

  it("propagates errors from downstream", () => {
    expect(() => specificFunction({ throw: true })).toThrow(/downstream/);
  });
});
```

## Fields

| Field | Type | Required | Purpose |
|---|---|---|---|
| `testFile` | string | yes | Path to the .lib.test.ts file relative to repo root |
| `targetPackage` | string | yes | Package name being tested (for audit trail and cross-review) |
| `timeoutMs` | number | no (default 60000, max 600000) | Vitest run timeout |

## Quality rules

1. **At least 3 `it()` test cases per test file.** One happy path, one edge, one error case is a minimum.
2. **Tests must import from the target package by name**, not relative path. This ensures the package's public API is what's being tested.
3. **No mocking the target package.** If you need to mock something, it should be a dependency of the target package, not the target itself.
4. **Literal reference to the deliverable target.** `targetPackage` must match the package from the issue's `verification_target`. If the target is a specific function, the test file must import it by name.
5. **No snapshot tests alone.** Snapshot matching without explicit assertions is too loose. Always pair snapshots with explicit `expect(x).toBe(y)` checks.

## Non-goals

- Integration tests that require a running server — use the api runner for those
- Tests that need a browser — use the url runner + Playwright
- Performance benchmarks — separate concern
- Coverage thresholds — too much complexity for Phase 3

## Reference example

Goal: verify that `@paperclipai/shared` exports a working `normalizeAgentUrlKey` function after a refactor.

**Spec (`DLD-9999.lib.spec.json`):**
```json
{
  "testFile": "skills/acceptance-lib-tests/tests/DLD-9999.lib.test.ts",
  "targetPackage": "@paperclipai/shared",
  "timeoutMs": 30000
}
```

**Test file (`DLD-9999.lib.test.ts`):**
```typescript
import { describe, it, expect } from "vitest";
import { normalizeAgentUrlKey } from "@paperclipai/shared";

describe("DLD-9999: normalizeAgentUrlKey", () => {
  it("converts multi-word names to kebab case", () => {
    expect(normalizeAgentUrlKey("Frontend QA Agent")).toBe("frontend-qa-agent");
  });

  it("strips non-alphanumeric characters", () => {
    expect(normalizeAgentUrlKey("QA Agent!")).toBe("qa-agent");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeAgentUrlKey("   ")).toBe("");
  });
});
```
