---
name: acceptance-cli-scripts
description: Use when authoring acceptance specs for CLI/script deliverables. One JSON spec per issue at tests/<DLD-XXXX>.cli.spec.json, consumed by the verification worker's cli-runner. Backend QA Agent owns this skill for every cli deliverable_type issue.
---

# CLI Acceptance Specs

## When to use

Backend QA Agent, assigned an issue with `deliverable_type: cli`. Write a JSON spec at `skills/acceptance-cli-scripts/tests/<DLD-XXXX>.cli.spec.json` before the engineer starts. The verification worker execs the declared argv, asserts exit code and stdout/stderr patterns.

## Spec format

```json
{
  "argv": ["/usr/bin/node", "-e", "console.log('hello')"],
  "expectedExitCode": 0,
  "timeoutMs": 30000,
  "expectedStdoutContains": ["hello"],
  "stdoutForbidden": ["error", "undefined"],
  "stderrForbidden": ["stack"],
  "cwd": "/app"
}
```

### Fields

| Field | Type | Required | Purpose |
|---|---|---|---|
| `argv` | string[] | yes | Executable + arguments. **No shell command string** — array form prevents shell metacharacter injection. |
| `expectedExitCode` | number | no (default 0) | Process exit code that counts as pass |
| `timeoutMs` | number | no (default 30000, max 600000) | Kill the process after this many ms |
| `expectedStdoutContains` | string[] | no | All substrings must appear in stdout |
| `stdoutForbidden` | string[] | no | None of these may appear in stdout |
| `stderrForbidden` | string[] | no | None of these may appear in stderr |
| `cwd` | string | no | Working directory for the command |

## Executable allowlist

The runner only executes binaries under these prefixes:

- `/usr/bin/`
- `/usr/local/bin/`
- `/bin/`
- `/app/node_modules/.bin/`

If your test target lives outside this set, wrap it: `argv: ["/usr/bin/env", "bash", "-c", "..."]` is rejected (env isn't allowlisted as a way to run arbitrary shell). Instead, add your binary to an allowed location or use Node: `argv: ["/usr/bin/node", "/app/scripts/my-script.js", "arg1"]`.

## Quality rules

1. **At least 3 effective assertions.** Exit code + at least one positive stdout check + at least one negative stderr check is a good minimum.
2. **No `sleep`-based waits.** If your script legitimately needs to wait for something, build it into the script — don't rely on the verifier's timeout.
3. **Deterministic output.** If the command prints timestamps or PIDs, match with substrings that exclude them.
4. **Literal reference to the deliverable target.** `argv[0]` or one of the `expectedStdoutContains` entries must reference the script/path from the issue's `verification_target`.

## Reference example

```json
{
  "argv": ["/usr/bin/node", "/app/scripts/check-env.js"],
  "expectedExitCode": 0,
  "expectedStdoutContains": ["all required env vars present"],
  "stderrForbidden": ["MISSING:", "undefined"],
  "timeoutMs": 10000
}
```

## Non-goals

- Shell pipelines (`foo | bar`) — not supported by argv model
- Interactive commands — the runner doesn't connect stdin
- Long-running daemons — timeout kills them
- Commands that require elevated privileges — runner executes as the `node` user inside the container
