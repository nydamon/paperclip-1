import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-idle-owner-sweep-"));
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

describe("sweepIdleOwnerIssues", () => {
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
      sql`TRUNCATE issues, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, activity_log, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedIdleIssueFixture(overrides?: {
    issueStatus?: "todo" | "in_progress" | "in_review";
    agentStatus?: string;
    updatedAt?: Date;
    checkoutRunId?: string | null;
    executionRunId?: string | null;
    executionLockedAt?: Date | null;
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
      name: "IdleOwner",
      role: "engineer",
      status: overrides?.agentStatus ?? "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idle issue",
      status: overrides?.issueStatus ?? "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: overrides?.checkoutRunId ?? null,
      executionRunId: overrides?.executionRunId ?? null,
      executionLockedAt: overrides?.executionLockedAt ?? null,
      updatedAt: overrides?.updatedAt ?? fiveHoursAgo,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
    });

    return { companyId, agentId, issueId };
  }

  it("warns and enqueues a wakeup for an unlocked idle-owned issue", async () => {
    const { issueId } = await seedIdleIssueFixture();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepIdleOwnerIssues();
    expect(result).toEqual({ warned: 1, escalated: 0, reawakened: 1 });

    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(logs.some((entry) => entry.action === "issue.idle_owner_warning")).toBe(true);

    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups.some((w) => w.reason === "idle_owner_retrigger")).toBe(true);
  });

  it("warns but does not enqueue a wakeup when the issue is locked", async () => {
    await seedIdleIssueFixture({ executionLockedAt: new Date() });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepIdleOwnerIssues();
    expect(result).toEqual({ warned: 1, escalated: 0, reawakened: 0 });

    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups.some((w) => w.reason === "idle_owner_retrigger")).toBe(false);
  });

  it("warns but does not enqueue a wakeup for a non-dispatchable agent", async () => {
    await seedIdleIssueFixture({ agentStatus: "paused" });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepIdleOwnerIssues();
    expect(result).toEqual({ warned: 1, escalated: 0, reawakened: 0 });

    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups.some((w) => w.reason === "idle_owner_retrigger")).toBe(false);
  });
});
