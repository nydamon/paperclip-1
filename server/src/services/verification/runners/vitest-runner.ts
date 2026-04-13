/**
 * Library deliverable runner (vitest).
 *
 * Runs a specific vitest test file against the server's workspace and asserts it passes.
 * Used for `lib_backend` and `lib_frontend` deliverables where the "target" is a package
 * function rather than a URL or HTTP endpoint.
 *
 * The runner execs `vitest run <spec-path>` inside the server container and parses the JSON
 * reporter output. The spec file lives at
 *   skills/acceptance-lib-tests/tests/<DLD-XXXX>.lib.test.ts
 * and imports from the target package under test.
 *
 * Unlike the Playwright runner, no SSH is involved — the test runs locally in the server
 * container, which has all workspace packages available.
 *
 * Spec format (JSON):
 *   {
 *     "testFile": "skills/acceptance-lib-tests/tests/DLD-1234.lib.test.ts",
 *     "targetPackage": "@paperclipai/adapter-utils",
 *     "timeoutMs": 60000
 *   }
 *
 * The runner assumes vitest is installed in the server workspace (it is — see vitest imports
 * in existing server tests).
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile as execFileDefault } from "node:child_process";

export interface RunVitestSpecInput {
  issueId: string;
  specPath: string;
  skillsRoot?: string;
  readFileImpl?: typeof readFile;
  execFileImpl?: typeof execFileDefault;
}

export type RunVitestSpecResult =
  | {
      status: "passed";
      durationMs: number;
      testsRun: number;
    }
  | {
      status: "failed";
      durationMs: number;
      failureSummary: string;
      stdout?: string;
    }
  | { status: "unavailable"; unavailableReason: string };

interface LibSpec {
  testFile: string;
  targetPackage: string;
  timeoutMs?: number;
}

function validateSpec(parsed: unknown): { ok: true; spec: LibSpec } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "spec not an object" };
  const s = parsed as Record<string, unknown>;
  if (
    typeof s.testFile !== "string" ||
    !/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.lib\.test\.ts$/.test(s.testFile)
  ) {
    return {
      ok: false,
      reason: "spec.testFile must be a path under skills/acceptance-<product>/tests/ ending in .lib.test.ts",
    };
  }
  if (typeof s.targetPackage !== "string" || !/^@?[a-z0-9-/]+$/.test(s.targetPackage)) {
    return { ok: false, reason: "spec.targetPackage must be a package name string" };
  }
  if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== "number" || s.timeoutMs <= 0 || s.timeoutMs > 600_000)) {
    return { ok: false, reason: "spec.timeoutMs must be a positive number <= 600000 if present" };
  }
  return { ok: true, spec: parsed as LibSpec };
}

interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: Array<{
    assertionResults?: Array<{
      status?: string;
      title?: string;
      failureMessages?: string[];
    }>;
    message?: string;
  }>;
}

function firstFailure(report: VitestJsonReport): string {
  for (const testFile of report.testResults ?? []) {
    for (const assertion of testFile.assertionResults ?? []) {
      if (assertion.status === "failed") {
        const msg = assertion.failureMessages?.[0] ?? "(no message)";
        return `${assertion.title ?? "unknown"}: ${msg.slice(0, 500)}`;
      }
    }
    if (testFile.message) return testFile.message.slice(0, 500);
  }
  return "unknown failure";
}

export async function runVitestSpec(input: RunVitestSpecInput): Promise<RunVitestSpecResult> {
  const {
    specPath,
    skillsRoot = "/app",
    readFileImpl = readFile,
    execFileImpl = execFileDefault,
  } = input;

  if (
    !/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.lib\.spec\.(json|yaml|yml)$/.test(specPath)
  ) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format for vitest runner: ${specPath}`,
    };
  }

  const absPath = resolve(join(skillsRoot, specPath));
  let raw: string;
  try {
    raw = await readFileImpl(absPath, "utf8");
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const check = validateSpec(parsed);
  if (!check.ok) return { status: "unavailable", unavailableReason: check.reason };
  const spec = check.spec;
  const timeoutMs = spec.timeoutMs ?? 60_000;

  const started = Date.now();

  return new Promise<RunVitestSpecResult>((resolveResult) => {
    // We invoke the vitest binary installed in the server workspace. The server container has
    // /app as the workspace root and pnpm-installed node_modules at /app/node_modules.
    execFileImpl(
      "/usr/local/bin/node",
      [
        "/app/node_modules/.bin/vitest",
        "run",
        spec.testFile,
        "--reporter=json",
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        cwd: skillsRoot,
        encoding: "utf8",
      },
      (err, stdoutRaw, stderrRaw) => {
        const durationMs = Math.floor(Date.now() - started);
        const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";
        const stderr = typeof stderrRaw === "string" ? stderrRaw : "";
        const killed = err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed;

        if (killed) {
          resolveResult({
            status: "unavailable",
            unavailableReason: `vitest killed after ${timeoutMs}ms timeout`,
          });
          return;
        }

        // Vitest JSON reporter emits the report to stdout. Pull out the outer object.
        const jsonStart = stdout.indexOf("{");
        const jsonEnd = stdout.lastIndexOf("}");
        if (jsonStart === -1 || jsonEnd === -1) {
          resolveResult({
            status: "unavailable",
            unavailableReason: `vitest did not emit a parseable report (exit: ${err ? "error" : 0}): ${stderr.slice(-500)}`,
          });
          return;
        }

        let report: VitestJsonReport;
        try {
          report = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as VitestJsonReport;
        } catch (parseErr) {
          resolveResult({
            status: "unavailable",
            unavailableReason: `vitest report parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          });
          return;
        }

        const numFailed = report.numFailedTests ?? 0;
        const numTotal = report.numTotalTests ?? 0;

        if (numFailed === 0 && numTotal > 0) {
          resolveResult({ status: "passed", durationMs, testsRun: numTotal });
          return;
        }
        if (numTotal === 0) {
          resolveResult({
            status: "unavailable",
            unavailableReason: "vitest reported zero tests executed",
          });
          return;
        }
        resolveResult({
          status: "failed",
          durationMs,
          failureSummary: firstFailure(report),
          stdout: stdout.slice(-2000),
        });
      },
    );
  });
}
