import { describe, it, expect, vi } from "vitest";
import { runConfigSpec } from "../services/verification/runners/config-runner.js";

// Each test provides a pair of reads: first the spec file, then the config file.
function makeReadFile(pairs: Record<string, string>) {
  return vi.fn(async (path: string) => {
    // Drop any absolute prefix we prepend during resolve()
    for (const [key, value] of Object.entries(pairs)) {
      if (path.endsWith(key) || path.includes(key)) return value;
    }
    throw new Error(`unexpected read: ${path}`);
  });
}

const validSpecPath = "skills/acceptance-configs/tests/DLD-1.config.spec.json";

describe("runConfigSpec", () => {
  it("rejects invalid spec path", async () => {
    const result = await runConfigSpec({
      issueId: "i",
      specPath: "not-valid",
      readFileImpl: makeReadFile({}),
    });
    expect(result.status).toBe("unavailable");
  });

  it("rejects spec with path traversal", async () => {
    const spec = {
      configPath: "../../etc/passwd",
      format: "json",
    };
    const result = await runConfigSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: makeReadFile({ "DLD-1.config.spec.json": JSON.stringify(spec) }),
    });
    expect(result.status).toBe("unavailable");
  });

  it("passes on valid JSON config matching schema", async () => {
    const spec = {
      configPath: "package.json",
      format: "json",
      expectedSchema: {
        type: "object",
        required: ["name", "version"],
        properties: { name: { type: "string" }, version: { type: "string" } },
      },
    };
    const configBody = JSON.stringify({ name: "paperclip", version: "1.0.0" });
    const result = await runConfigSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: makeReadFile({
        "DLD-1.config.spec.json": JSON.stringify(spec),
        "package.json": configBody,
      }),
    });
    expect(result.status).toBe("passed");
  });

  it("fails on JSON config missing required field", async () => {
    const spec = {
      configPath: "package.json",
      format: "json",
      expectedSchema: {
        type: "object",
        required: ["name", "version"],
        properties: { name: { type: "string" }, version: { type: "string" } },
      },
    };
    const configBody = JSON.stringify({ name: "paperclip" });
    const result = await runConfigSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: makeReadFile({
        "DLD-1.config.spec.json": JSON.stringify(spec),
        "package.json": configBody,
      }),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failureSummary).toContain("version");
  });

  it("fails when notContains substring found", async () => {
    const spec = {
      configPath: "config.json",
      format: "json",
      notContains: ["TODO"],
    };
    const result = await runConfigSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: makeReadFile({
        "DLD-1.config.spec.json": JSON.stringify(spec),
        "config.json": '{"note": "TODO later"}',
      }),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failureSummary).toContain("forbidden");
  });

  it("passes env file with all required keys", async () => {
    const spec = {
      configPath: ".env.example",
      format: "env",
      requiredKeys: ["DATABASE_URL", "SECRET"],
    };
    const result = await runConfigSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: makeReadFile({
        "DLD-1.config.spec.json": JSON.stringify(spec),
        ".env.example": "DATABASE_URL=postgres://x\nSECRET=y\nOPTIONAL=z\n",
      }),
    });
    expect(result.status).toBe("passed");
  });

  it("fails env file missing required key", async () => {
    const spec = {
      configPath: ".env.example",
      format: "env",
      requiredKeys: ["DATABASE_URL", "SECRET"],
    };
    const result = await runConfigSpec({
      issueId: "i",
      specPath: validSpecPath,
      readFileImpl: makeReadFile({
        "DLD-1.config.spec.json": JSON.stringify(spec),
        ".env.example": "DATABASE_URL=postgres://x\n",
      }),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failureSummary).toContain("SECRET");
  });
});
