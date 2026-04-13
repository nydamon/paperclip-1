/**
 * CLI deliverable runner.
 *
 * Executes a shell command declared in a JSON spec file and asserts:
 *   - exit code matches expectedExitCode (default 0)
 *   - stdout contains all expectedStdoutContains substrings
 *   - stdout does NOT contain any stdoutForbidden substrings
 *   - stderr does NOT contain any stderrForbidden substrings
 *   - (optional) command completes within timeoutMs
 *
 * The runner executes inside the Paperclip server container. It does NOT run arbitrary shell
 * — the spec declares an `argv` array (executable + arguments), not a shell command string.
 * This forces specs to use array-based invocation, which is immune to shell metacharacter injection.
 *
 * Spec format (JSON):
 *   {
 *     "argv": ["/usr/bin/node", "-e", "console.log('hello')"],
 *     "expectedExitCode": 0,
 *     "timeoutMs": 30000,
 *     "expectedStdoutContains": ["hello"],
 *     "stdoutForbidden": ["error", "undefined"],
 *     "stderrForbidden": ["stack"]
 *   }
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile as execFileDefault } from "node:child_process";

export interface RunCliSpecInput {
  issueId: string;
  specPath: string;
  skillsRoot?: string;
  readFileImpl?: typeof readFile;
  execFileImpl?: typeof execFileDefault;
}

export type RunCliSpecResult =
  | { status: "passed"; durationMs: number; exitCode: number }
  | {
      status: "failed";
      durationMs: number;
      failureSummary: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }
  | { status: "unavailable"; unavailableReason: string };

interface CliSpec {
  argv: string[];
  expectedExitCode?: number;
  timeoutMs?: number;
  expectedStdoutContains?: string[];
  stdoutForbidden?: string[];
  stderrForbidden?: string[];
  cwd?: string;
}

const ALLOWED_EXECUTABLE_PREFIXES = [
  "/usr/bin/",
  "/usr/local/bin/",
  "/bin/",
  "/app/node_modules/.bin/",
];

function validateSpec(parsed: unknown): { ok: true; spec: CliSpec } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "spec not an object" };
  const s = parsed as Record<string, unknown>;
  if (!Array.isArray(s.argv) || s.argv.length === 0) {
    return { ok: false, reason: "spec.argv must be a non-empty array" };
  }
  if (!s.argv.every((x) => typeof x === "string")) {
    return { ok: false, reason: "spec.argv must be an array of strings" };
  }
  const executable = s.argv[0] as string;
  if (!ALLOWED_EXECUTABLE_PREFIXES.some((p) => executable.startsWith(p))) {
    return {
      ok: false,
      reason: `executable must live under one of: ${ALLOWED_EXECUTABLE_PREFIXES.join(", ")} — got ${executable}`,
    };
  }
  if (s.expectedExitCode !== undefined && typeof s.expectedExitCode !== "number") {
    return { ok: false, reason: "spec.expectedExitCode must be a number if present" };
  }
  if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== "number" || s.timeoutMs <= 0 || s.timeoutMs > 600_000)) {
    return { ok: false, reason: "spec.timeoutMs must be a positive number <= 600000 (10 min)" };
  }
  if (s.cwd !== undefined && typeof s.cwd !== "string") {
    return { ok: false, reason: "spec.cwd must be a string if present" };
  }
  for (const key of ["expectedStdoutContains", "stdoutForbidden", "stderrForbidden"] as const) {
    if (s[key] !== undefined) {
      if (!Array.isArray(s[key]) || !(s[key] as unknown[]).every((x) => typeof x === "string")) {
        return { ok: false, reason: `spec.${key} must be an array of strings if present` };
      }
    }
  }
  return { ok: true, spec: parsed as CliSpec };
}

export async function runCliSpec(input: RunCliSpecInput): Promise<RunCliSpecResult> {
  const {
    specPath,
    skillsRoot = "/app",
    readFileImpl = readFile,
    execFileImpl = execFileDefault,
  } = input;

  if (
    !/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.cli\.spec\.(json|yaml|yml)$/.test(specPath)
  ) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format for cli runner: ${specPath}`,
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
  const expectedExitCode = spec.expectedExitCode ?? 0;
  const timeoutMs = spec.timeoutMs ?? 30_000;

  const started = Date.now();
  const executable = spec.argv[0];
  const args = spec.argv.slice(1);

  return new Promise<RunCliSpecResult>((resolveResult) => {
    execFileImpl(
      executable,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd: spec.cwd, encoding: "utf8" },
      (err, stdoutRaw, stderrRaw) => {
        const durationMs = Math.floor(Date.now() - started);
        const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";
        const stderr = typeof stderrRaw === "string" ? stderrRaw : "";
        // execFile sets err when exit code is non-zero OR when process was killed
        const exitCode =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as NodeJS.ErrnoException).code as unknown as number)
            : err
              ? 1
              : 0;
        const killed = err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed;

        if (killed) {
          resolveResult({
            status: "failed",
            durationMs,
            failureSummary: `command killed (likely exceeded timeout ${timeoutMs}ms)`,
            exitCode,
            stdout: stdout.slice(0, 1000),
            stderr: stderr.slice(0, 1000),
          });
          return;
        }

        if (exitCode !== expectedExitCode) {
          resolveResult({
            status: "failed",
            durationMs,
            failureSummary: `exit code ${exitCode}, expected ${expectedExitCode}`,
            exitCode,
            stdout: stdout.slice(0, 1000),
            stderr: stderr.slice(0, 1000),
          });
          return;
        }

        // Positive stdout assertions
        if (spec.expectedStdoutContains) {
          for (const s of spec.expectedStdoutContains) {
            if (!stdout.includes(s)) {
              resolveResult({
                status: "failed",
                durationMs,
                failureSummary: `stdout missing required substring: "${s.slice(0, 80)}"`,
                exitCode,
                stdout: stdout.slice(0, 1000),
                stderr: stderr.slice(0, 1000),
              });
              return;
            }
          }
        }

        // Negative stdout assertions
        if (spec.stdoutForbidden) {
          for (const s of spec.stdoutForbidden) {
            if (stdout.includes(s)) {
              resolveResult({
                status: "failed",
                durationMs,
                failureSummary: `stdout contained forbidden substring: "${s.slice(0, 80)}"`,
                exitCode,
                stdout: stdout.slice(0, 1000),
                stderr: stderr.slice(0, 1000),
              });
              return;
            }
          }
        }

        // Negative stderr assertions
        if (spec.stderrForbidden) {
          for (const s of spec.stderrForbidden) {
            if (stderr.includes(s)) {
              resolveResult({
                status: "failed",
                durationMs,
                failureSummary: `stderr contained forbidden substring: "${s.slice(0, 80)}"`,
                exitCode,
                stdout: stdout.slice(0, 1000),
                stderr: stderr.slice(0, 1000),
              });
              return;
            }
          }
        }

        resolveResult({ status: "passed", durationMs, exitCode });
      },
    );
  });
}
