import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.ts";

type IssueRow = {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
};

function createDbStub(existing: IssueRow | null) {
  const selectWhere = vi.fn(async () => (existing ? [existing] : []));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const returning = vi.fn(async () => []);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: {
      select,
      update,
    },
    set,
  };
}

describe("issueService.release", () => {
  it("clears execution lock fields when releasing an issue", async () => {
    const dbStub = createDbStub({
      id: "issue-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      checkoutRunId: "run-1",
    });
    const svc = issueService(dbStub.db as any);

    await svc.release("issue-1");

    expect(dbStub.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
    );
  });
});
