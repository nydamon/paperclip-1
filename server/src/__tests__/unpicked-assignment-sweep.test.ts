import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-unpicked-sweep-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, instance, dataDir };
}

describe("sweepUnpickedAssignments", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    // Use TRUNCATE CASCADE to handle complex FK chains from enqueueWakeup side effects.
    await db.execute(
      sql`TRUNCATE issues, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedIssueFixture(overrides?: {
    agentStatus?: string;
    issueStatus?: string;
    executionRunId?: string | null;
    executionLockedAt?: Date | null;
    checkoutRunId?: string | null;
    updatedAt?: Date;
    activationRetriggerCount?: number;
    /** When true, inserts a separate running heartbeat run for the agent (distinct from the issue's executionRunId). */
    agentHasRunningRun?: boolean;
    /** Sets completedAt — simulates a just-completed (done) issue. */
    completedAt?: Date | null;
    /** Sets hiddenAt — simulates a soft-deleted issue. */
    hiddenAt?: Date | null;
    /** Sets originKind — simulates a routine_execution issue. */
    originKind?: string;
    /** Sets startedAt — simulates a task that has been checked out. */
    startedAt?: Date | null;
    /** When originKind is 'routine_execution', optionally set createdByAgentId to simulate self-assigned routine task. */
    createdByAgentId?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: overrides?.agentStatus ?? "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // If we need a heartbeat run for executionRunId, insert one
    let runId: string | null = null;
    if (overrides?.executionRunId) {
      runId = overrides.executionRunId;
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        source: "assignment",
        startedAt: new Date(),
      });
    }

    // Optionally insert a running heartbeat run for the agent itself (separate
    // from the issue's executionRunId). This simulates the agent already being
    // mid-dispatch so sweepUnpickedAssignments should skip the issue.
    if (overrides?.agentHasRunningRun) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "running",
        source: "routine",
        startedAt: new Date(),
      });
    }

    const nineMinutesAgo = new Date(Date.now() - 9 * 60 * 1000);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: overrides?.issueStatus ?? "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionLockedAt: overrides?.executionLockedAt ?? null,
      checkoutRunId: overrides?.checkoutRunId ?? null,
      updatedAt: overrides?.updatedAt ?? nineMinutesAgo,
      activationRetriggerCount: overrides?.activationRetriggerCount ?? 0,
      completedAt: overrides?.completedAt ?? null,
      hiddenAt: overrides?.hiddenAt ?? null,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
      originKind: overrides?.originKind ?? "manual",
      startedAt: overrides?.startedAt ?? null,
      createdByAgentId: overrides?.createdByAgentId ?? null,
    });

    return { companyId, agentId, issueId };
  }

  it("retriggers an actionable issue past the SLA with no run", async () => {
    const { issueId } = await seedIssueFixture();

    // Verify the column exists and is 0
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(before.activationRetriggerCount).toBe(0);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(1);

    // Verify the retrigger count was incremented
    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.activationRetriggerCount).toBe(1);

    // Verify a wakeup was enqueued
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups.length).toBeGreaterThanOrEqual(1);
    const wakeup = wakeups.find((w) => w.reason === "unpicked_assignment_retrigger");
    expect(wakeup).toBeTruthy();
  });

  it("skips an issue that already has an executionRunId", async () => {
    await seedIssueFixture({ executionRunId: randomUUID() });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue updated recently (within SLA window)", async () => {
    await seedIssueFixture({ updatedAt: new Date() }); // just now

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue that has reached max retrigger count", async () => {
    await seedIssueFixture({ activationRetriggerCount: 5 }); // MAX_RETRIGGERS = 5

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips a soft-deleted (hidden) issue", async () => {
    // ← FIX (DLD-3621): hiddenAt is now filtered in the WHERE clause.
    // Phantom wakes were caused by the sweeper picking up soft-deleted issues.
    await seedIssueFixture({ hiddenAt: new Date() });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue completed within the last minute (completedAt debounce)", async () => {
    // ← FIX (DLD-3621): completedAt debounce prevents firing on recently-done issues.
    // This closes the race condition where an issue transitions to done between
    // the sweeper SELECT and the enqueueWakeup call.
    await seedIssueFixture({ completedAt: new Date() }); // just now

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue whose assignee agent already has a running heartbeat run", async () => {
    // ← FIX (DLD-3621): running-agent guard prevents hammering an agent that is
    // already mid-dispatch — it will naturally pick up its own issue on the next
    // routine heartbeat without needing an additional wakeup.
    await seedIssueFixture({ agentHasRunningRun: true });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips an issue assigned to a non-dispatchable agent", async () => {
    await seedIssueFixture({ agentStatus: "paused" });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("skips a routine_execution task that has not been picked up (originKind + startedAt null)", async () => {
    // ← FIX (DLD-3623): When a routine scheduler creates a routine_execution task and assigns
    // it to the agent that owns the routine, the sweeper should NOT retrigger on it.
    // The agent will naturally pick up the task on its next routine heartbeat.
    // Retriggering creates phantom wake cascades where Monitor wakes every heartbeat
    // on its own routine tasks and creates escalation issues.
    await seedIssueFixture({
      originKind: "routine_execution",
      startedAt: null,
      createdByAgentId: null, // routine scheduler sets this to null
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(0);
  });

  it("still retriggers a routine_execution task that HAS been picked up (startedAt is set)", async () => {
    // A routine task that was checked out but the agent lost it should still be retriggered.
    await seedIssueFixture({
      originKind: "routine_execution",
      startedAt: new Date(), // agent checked it out — this is now a real unpicked issue
      createdByAgentId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepUnpickedAssignments();
    expect(result.retriggered).toBe(1);
  });
});

describe("cancelQueuedRunsForTerminalIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.execute(
      sql`TRUNCATE issues, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("cancels queued run when the target issue has been deleted (phantom issue)", async () => {
    // ← FIX (DLD-3621): Cancels queued runs pointing to issues that no longer exist
    // in the DB. Without this, orphaned queued runs sit until the next 5-min sweep,
    // causing phantom wakes on agents (e.g. Monitor waking on DLD-3618 which doesn't exist).
    const companyId = randomUUID();
    const agentId = randomUUID();
    const deletedIssueId = randomUUID(); // issue that will NOT be inserted
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Insert a queued run pointing to the non-existent issue ID
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      source: "automation",
      contextSnapshot: { issueId: deletedIssueId, source: "unpicked_assignment_retrigger" },
    });

    // Verify the run is queued before the fix
    const [runBefore] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runBefore.status).toBe("queued");

    // Verify the issue row does not exist
    const issuesExist = await db.select().from(issues).where(eq(issues.id, deletedIssueId));
    expect(issuesExist.length).toBe(0);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.cancelQueuedRunsForTerminalIssues();

    // The fix: LEFT JOIN + isNull(issues.id) must catch orphaned runs
    expect(result.cancelled).toBe(1);

    const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runAfter.status).toBe("cancelled");
  });

  it("cancels queued run when target issue is done", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Done issue",
      status: "done",
      identifier: "TST-1",
      issueNumber: 1,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      source: "automation",
      contextSnapshot: { issueId, source: "unpicked_assignment_retrigger" },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.cancelQueuedRunsForTerminalIssues();

    expect(result.cancelled).toBe(1);
    const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runAfter.status).toBe("cancelled");
  });

  it("does not cancel queued run for non-terminal (active) issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active issue",
      status: "todo",
      identifier: "TST-1",
      issueNumber: 1,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      source: "automation",
      contextSnapshot: { issueId, source: "unpicked_assignment_retrigger" },
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.cancelQueuedRunsForTerminalIssues();

    // No cancellation — the issue is still active (todo/in_progress/blocked)
    expect(result.cancelled).toBe(0);
    const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runAfter.status).toBe("queued");
  });
});
