import { describe, it, expect, vi } from "vitest";
import { runVitestSpec } from "../services/verification/runners/vitest-runner.js";

type ExecFileCallback = (
  err: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;

function makeMockExecFile(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
}) {
  return vi.fn((_cmd: string, _args: string[], _options: unknown, cb: unknown) => {
    const callback = cb as ExecFileCallback;
    const stdout = opts.stdout ?? "";
    const stderr = opts.stderr ?? "";
    if (opts.killed) {
      const err: NodeJS.ErrnoException & { killed?: boolean } = new Error("killed") as never;
      err.killed = true;
      callback(err, stdout, stderr);
    } else if (opts.exitCode && opts.exitCode !== 0) {
      const err: NodeJS.ErrnoException = new Error("exit") as never;
      callback(err, stdout, stderr);
    } else {
      callback(null, stdout, stderr);
    }
  });
}

const readFileFrom = (body: string) => vi.fn(async () => body);
const validSpecPath = "skills/acceptance-lib-tests/tests/DLD-1.lib.spec.json";

describe("runVitestSpec", () => {
  it("rejects invalid spec path format", async () => {
    const result = await runVitestSpec({
      issueId: "i",
      specPath: "not-valid",
      readFileImpl: readFileFrom("{}"),
      execFileImpl: makeMockExecFile({}) as unknown as never,
    });
    expect(result.status).toBe("unavailable");
  });

  it("rejects spec with invalid testFile path", async () => {
    const spec = {
      testFile: "../../etc/passwd",
      targetPackage: "@paperclipai/adapter-utils",
    };
    const result = await runVitestSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({}) as unknown as never,
    });
    expect(result.status).toBe("unavailable");
  });

  it("passes when vitest reports all tests passed", async () => {
    const spec = {
      testFile: "skills/acceptance-lib-tests/tests/DLD-1.lib.test.ts",
      targetPackage: "@paperclipai/shared",
    };
    const report = JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
    });
    const result = await runVitestSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ stdout: report }) as unknown as never,
    });
    expect(result.status).toBe("passed");
    if (result.status === "passed") expect(result.testsRun).toBe(3);
  });

  it("fails with failure summary when tests fail", async () => {
    const spec = {
      testFile: "skills/acceptance-lib-tests/tests/DLD-1.lib.test.ts",
      targetPackage: "@paperclipai/shared",
    };
    const report = JSON.stringify({
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          assertionResults: [
            {
              status: "passed",
              title: "ok test",
            },
            {
              status: "failed",
              title: "broken test",
              failureMessages: ["expected 1 but got 2"],
            },
          ],
        },
      ],
    });
    const result = await runVitestSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ stdout: report, exitCode: 1 }) as unknown as never,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureSummary).toContain("broken test");
      expect(result.failureSummary).toContain("expected 1 but got 2");
    }
  });

  it("returns unavailable on timeout kill", async () => {
    const spec = {
      testFile: "skills/acceptance-lib-tests/tests/DLD-1.lib.test.ts",
      targetPackage: "@paperclipai/shared",
      timeoutMs: 1000,
    };
    const result = await runVitestSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ killed: true }) as unknown as never,
    });
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when report has no parseable JSON", async () => {
    const spec = {
      testFile: "skills/acceptance-lib-tests/tests/DLD-1.lib.test.ts",
      targetPackage: "@paperclipai/shared",
    };
    const result = await runVitestSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ stdout: "Error: module not found" }) as unknown as never,
    });
    expect(result.status).toBe("unavailable");
  });
});
