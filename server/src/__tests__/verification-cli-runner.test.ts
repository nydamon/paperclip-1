import { describe, it, expect, vi } from "vitest";
import { runCliSpec } from "../services/verification/runners/cli-runner.js";

const readFileFrom = (body: string) => vi.fn(async () => body);

// Mock execFile signature matches node:child_process execFile
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
    if (opts.exitCode && opts.exitCode !== 0) {
      const err: NodeJS.ErrnoException & { killed?: boolean } = new Error("exit") as never;
      err.code = opts.exitCode as unknown as string;
      err.killed = opts.killed ?? false;
      callback(err, stdout, stderr);
    } else if (opts.killed) {
      const err: NodeJS.ErrnoException & { killed?: boolean } = new Error("killed") as never;
      err.killed = true;
      callback(err, stdout, stderr);
    } else {
      callback(null, stdout, stderr);
    }
  });
}

const validSpecPath = "skills/acceptance-cli-scripts/tests/DLD-1.cli.spec.json";

describe("runCliSpec", () => {
  it("rejects invalid spec path", async () => {
    const result = await runCliSpec({
      issueId: "i",
      specPath: "not-valid",
      readFileImpl: readFileFrom("{}"),
      execFileImpl: makeMockExecFile({}) as unknown as never,
    });
    expect(result.status).toBe("unavailable");
  });

  it("rejects argv with disallowed executable path", async () => {
    const spec = {
      argv: ["/etc/passwd", "-r"],
      expectedExitCode: 0,
    };
    const result = await runCliSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({}) as unknown as never,
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.unavailableReason).toContain("executable must live under");
    }
  });

  it("passes when exit code matches and stdout contains required substring", async () => {
    const spec = {
      argv: ["/usr/bin/echo", "hello world"],
      expectedExitCode: 0,
      expectedStdoutContains: ["hello"],
    };
    const result = await runCliSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ stdout: "hello world\n" }) as unknown as never,
    });
    expect(result.status).toBe("passed");
  });

  it("fails on wrong exit code", async () => {
    const spec = { argv: ["/usr/bin/false"], expectedExitCode: 0 };
    const result = await runCliSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ exitCode: 1 }) as unknown as never,
    });
    expect(result.status).toBe("failed");
  });

  it("fails when stdout missing required substring", async () => {
    const spec = {
      argv: ["/usr/bin/echo", "foo"],
      expectedStdoutContains: ["bar"],
    };
    const result = await runCliSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ stdout: "foo\n" }) as unknown as never,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failureSummary).toContain("missing");
  });

  it("fails when stdout contains forbidden substring", async () => {
    const spec = {
      argv: ["/usr/bin/echo", "x"],
      stdoutForbidden: ["deprecated"],
    };
    const result = await runCliSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ stdout: "using deprecated api\n" }) as unknown as never,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failureSummary).toContain("forbidden");
  });

  it("fails when killed by timeout", async () => {
    const spec = { argv: ["/usr/bin/sleep", "100"], timeoutMs: 1000 };
    const result = await runCliSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: readFileFrom(JSON.stringify(spec)),
      execFileImpl: makeMockExecFile({ killed: true, exitCode: 1 }) as unknown as never,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failureSummary).toContain("killed");
  });
});
