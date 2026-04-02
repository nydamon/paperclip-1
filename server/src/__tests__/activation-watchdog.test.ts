import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-activation-watchdog-"));
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

describe("activation watchdog: sweepUnpickedAssignments", () => {
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

  /**
   * Seeds a company/agent/issue for watchdog testing.
   *
   * For "old enough to sweep" issues (default): updatedAt is set to a fixed past date
   * (2020-01-01) so it is always well beyond any SLA window.
   *
   * For "fresh/within SLA" issues: pass `fresh: true` to omit the explicit updatedAt
   * so the DB defaultNow() is used (current time, within SLA).
   */
  async function seedUnpickedIssue(opts: {
    agentStatus?: string;
    retriggerCount?: number;
    issueStatus?: string;
    /** If true, issue was just updated (within SLA). Default: false (old issue). */
    fresh?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    // Use a safely old date so the issue is always outside the 8-minute SLA window.
    const oldDate = new Date("2020-01-01T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: opts.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600 } },
      permissions: {},
      lastHeartbeatAt: oldDate,
    });

    const issueValues: Parameters<ReturnType<typeof db.insert>["values"]>[0] = {
      id: issueId,
      companyId,
      title: "Unpicked assignment",
      status: opts.issueStatus ?? "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      activationRetriggerCount: opts.retriggerCount ?? 0,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      ...(opts.fresh ? {} : { updatedAt: oldDate, createdAt: oldDate }),
    };

    await db.insert(issues).values(issueValues);

    // sweepNow = current time; old issues (updatedAt=2020) are always past the 8-min SLA.
    const sweepNow = new Date();

    return { companyId, agentId, issueId, issuePrefix, sweepNow };
  }

  /** Fetch the current activationRetriggerCount for an issue. */
  async function getRetriggerCount(issueId: string): Promise<number> {
    const row = await db.select({ c: issues.activationRetriggerCount }).from(issues).where(eq(issues.id, issueId)).then((r) => r[0]);
    return row?.c ?? 0;
  }

  it("increments activationRetriggerCount for an in_progress issue past the SLA window", async () => {
    const { issueId, sweepNow } = await seedUnpickedIssue();
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepUnpickedAssignments({
      slaWindowMs: 8 * 60 * 1000,
      maxRetriggers: 99,
      now: sweepNow,
    });

    expect(await getRetriggerCount(issueId)).toBe(1);
  });

  it("enqueues a wakeup run for the assignee agent when retriggered", async () => {
    const { agentId, issueId, sweepNow } = await seedUnpickedIssue();
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepUnpickedAssignments({
      slaWindowMs: 8 * 60 * 1000,
      maxRetriggers: 99,
      now: sweepNow,
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const watchdogRun = runs.find(
      (r) =>
        (r.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId &&
        (r.contextSnapshot as Record<string, unknown> | null)?.source === "activation_watchdog",
    );
    expect(watchdogRun).toBeDefined();
  });

  it("does NOT increment activationRetriggerCount when issue was updated within the SLA window", async () => {
    // Issue seeded as fresh (updatedAt = DB defaultNow = current time, within SLA).
    const { issueId, sweepNow } = await seedUnpickedIssue({ fresh: true });
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepUnpickedAssignments({
      slaWindowMs: 8 * 60 * 1000,
      maxRetriggers: 99,
      now: sweepNow,
    });

    expect(await getRetriggerCount(issueId)).toBe(0);
  });

  it("does NOT increment activationRetriggerCount when maxRetriggers already reached", async () => {
    const { issueId, sweepNow } = await seedUnpickedIssue({ retriggerCount: 1 });
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepUnpickedAssignments({
      slaWindowMs: 8 * 60 * 1000,
      maxRetriggers: 1,
      now: sweepNow,
    });

    // Count should remain at 1 (escalated, not incremented).
    expect(await getRetriggerCount(issueId)).toBe(1);
  });

  it("does NOT increment activationRetriggerCount for a paused agent", async () => {
    const { issueId, sweepNow } = await seedUnpickedIssue({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepUnpickedAssignments({
      slaWindowMs: 8 * 60 * 1000,
      maxRetriggers: 99,
      now: sweepNow,
    });

    expect(await getRetriggerCount(issueId)).toBe(0);
  });

  it("does NOT increment activationRetriggerCount for a terminated agent", async () => {
    const { issueId, sweepNow } = await seedUnpickedIssue({ agentStatus: "terminated" });
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepUnpickedAssignments({
      slaWindowMs: 8 * 60 * 1000,
      maxRetriggers: 99,
      now: sweepNow,
    });

    expect(await getRetriggerCount(issueId)).toBe(0);
  });

  it("increments activationRetriggerCount for an in_review issue past the SLA window", async () => {
    const { issueId, sweepNow } = await seedUnpickedIssue({ issueStatus: "in_review" });
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepUnpickedAssignments({
      slaWindowMs: 8 * 60 * 1000,
      maxRetriggers: 99,
      now: sweepNow,
    });

    expect(await getRetriggerCount(issueId)).toBe(1);
  });
});
