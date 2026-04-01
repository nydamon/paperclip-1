import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-idle-dispatch-gap-"));
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

describe("idle-agent dispatch gap recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedIdleIssueGap() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lastHeartbeatAt = new Date("2026-03-30T21:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Senior Platform Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600 } },
      permissions: {},
      lastHeartbeatAt,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review queue is stuck on the assignee",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, lastHeartbeatAt };
  }

  async function waitForAgentRunsToSettle(agentId: string) {
    const timeoutAt = Date.now() + 10_000;
    while (Date.now() < timeoutAt) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
      if (activeRuns.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stillActiveRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
    throw new Error(
      `Timed out waiting for agent runs to settle (${stillActiveRuns.length} active): ${stillActiveRuns
        .map((run) => `${run.id}:${run.status}`)
        .join(", ")}`,
    );
  }

  it("requeues idle assigned work even when the normal heartbeat interval has not elapsed", async () => {
    const { agentId, issueId, lastHeartbeatAt } = await seedIdleIssueGap();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(new Date(lastHeartbeatAt.getTime() + 60_000));

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);

    const runForIssue = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows.find((row) => (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId) ?? null);
    expect(runForIssue).not.toBeNull();

    await waitForAgentRunsToSettle(agentId);
  });

  it("surfaces recoverable idle-work dispatch gaps in the dashboard summary", async () => {
    const { companyId } = await seedIdleIssueGap();
    const dashboard = dashboardService(db);

    const summary = await dashboard.summary(companyId);

    expect(summary.dispatch?.idleAgentsWithAssignedWork).toBe(1);
    expect(summary.dispatch?.recoverableIssueCount).toBe(1);
    expect(summary.dispatch?.samples.length).toBe(1);
    expect(summary.dispatch?.samples[0]).toMatchObject({
      reasonClass: "activation_pending_first_adoption",
      adoptionReceipt: "missing",
      latestWakeSource: null,
      latestWakeReason: null,
      autoRecoveryAttempts: 0,
    });
    expect(summary.dispatch?.samples[0]?.issueIdentifier).toMatch(/^T[A-Z0-9]+-1$/);
  });

  it("escalates when a prior auto-recovery attempt exists but activation still has no first progress", async () => {
    const { companyId, agentId, issueId, lastHeartbeatAt } = await seedIdleIssueGap();
    const heartbeat = heartbeatService(db);

    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "idle_issue_dispatch_gap",
      payload: { issueId },
      status: "failed",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });

    await heartbeat.tickTimers(new Date(lastHeartbeatAt.getTime() + 60_000));
    const wakeCountAfterTick = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.reason, "idle_issue_dispatch_gap"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
    expect(wakeCountAfterTick).toBe(1);

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const escalationComment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(issueComments.createdAt)
      .then((rows) => rows[rows.length - 1] ?? null);
    expect(escalationComment?.body).toContain("activation_failure_");
  });
});
