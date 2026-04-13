import { describe, it, expect, vi } from "vitest";
import { evalTerminalOutputGate } from "../services/verification/terminal-output-gate.js";

/**
 * Mock db with a fluent query-builder that returns caller-configured counts.
 * The gate makes 4 parallel calls: workProducts, attachments, documents, comments.
 * We track call order and return values from a configurable array.
 */
function makeDb(opts: {
  workProducts?: number;
  attachments?: number;
  documents?: number;
  commentBodies?: string[];
}) {
  const workProducts = opts.workProducts ?? 0;
  const attachments = opts.attachments ?? 0;
  const documents = opts.documents ?? 0;
  const commentBodies = opts.commentBodies ?? [];
  let callIndex = 0;

  const db = {
    select: vi.fn((_cols?: unknown) => {
      const invocation = callIndex;
      callIndex += 1;
      return {
        from: () => ({
          where: () => {
            // Call order mirrors the gate: wp, attach, doc, comments
            const result: unknown =
              invocation === 0
                ? [{ count: workProducts }]
                : invocation === 1
                  ? [{ count: attachments }]
                  : invocation === 2
                    ? [{ count: documents }]
                    : commentBodies.map((body) => ({ body }));
            return {
              then: (resolver: (rows: unknown[]) => unknown) => resolver(result as unknown[]),
            };
          },
        }),
      };
    }),
  };
  return db as unknown as Parameters<typeof evalTerminalOutputGate>[0];
}

const baseInput = {
  issueId: "issue-abc",
  targetStatus: "done",
  fromStatus: "in_review",
  executionWorkspaceId: "ws-1",
  actorType: "agent" as const,
};

describe("evalTerminalOutputGate", () => {
  it("does not block board actors", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, {
      ...baseInput,
      actorType: "board" as unknown as "agent",
    });
    expect(result.blocked).toBe(false);
  });

  it("does not block non-done transitions", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, { ...baseInput, targetStatus: "in_review" });
    expect(result.blocked).toBe(false);
  });

  it("does not block when fromStatus is already done (idempotent)", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, { ...baseInput, fromStatus: "done" });
    expect(result.blocked).toBe(false);
  });

  it("does not block non-code issues (no executionWorkspaceId)", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, { ...baseInput, executionWorkspaceId: null });
    expect(result.blocked).toBe(false);
  });

  it("passes when at least one work product exists", async () => {
    const db = makeDb({ workProducts: 1 });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("passes when at least one attachment exists", async () => {
    const db = makeDb({ attachments: 1 });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("passes when at least one document exists", async () => {
    const db = makeDb({ documents: 1 });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("passes with a substantive comment that references a URL deliverable", async () => {
    const longBody =
      "Detailed writeup of the investigation. See https://github.com/viraforge/paperclip/pull/123 for the fix. ".repeat(4);
    const db = makeDb({ commentBodies: [longBody] });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("passes with a substantive comment that references a file path + SHA", async () => {
    const longBody =
      "Writeup below. The change lives at server/src/services/verification/terminal-output-gate.ts and was committed as 49eb82a8b2c1 to main. ".repeat(3);
    const db = makeDb({ commentBodies: [longBody] });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("BLOCKS long explanatory comments with NO deliverable reference (DLD-2805 pattern)", async () => {
    // This is the real DLD-2805 profile: long comments explaining why work didn't happen,
    // zero URLs, zero file paths, zero SHAs, zero PR references.
    const dldPatternBodies = [
      "Lane 5 wontfix credentials absent for COMPOSIO and HEYGEN. Credentials not provided by board across multiple escalation rounds spanning morning hours. Lane is out of scope without credentials. The execution result produced no artifact because credentials were never set in the agent runtime environment.",
      "Watchdog nudge: please post current artifact or blocker in this lane within the next twenty minutes. Required: concrete output reference or blocker reason, next step, estimated completion. Without credentials no execution is possible and no output can be produced.",
      "CEO directive received. Closing lane as wontfix per board routing. Execution result is none. No output produced because the credential gate blocks all code execution in this environment and the runtime has no way to call the external provider.",
    ];
    const db = makeDb({ commentBodies: dldPatternBodies });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("cancelled");
  });

  it("does NOT count trivial 'QA: PASS. done. closed.' comments as substantive", async () => {
    // A comment that's entirely trivial closing phrases with only punctuation between them
    // should strip down to near-empty after phrase removal.
    const body = "QA: PASS. " + "done. closed. resolved. ".repeat(40);
    const db = makeDb({ commentBodies: [body] });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(true);
  });

  it("does NOT count short comments as substantive", async () => {
    const db = makeDb({ commentBodies: ["OK looks good"] });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(true);
  });

  it("BLOCKS when everything is zero (DLD-2805 pattern)", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(true);
    expect(result.gate).toBe("terminal_status_requires_output");
    expect(result.reason).toContain("cancelled");
    expect(result.debug?.workProductCount).toBe(0);
  });
});
