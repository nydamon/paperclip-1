import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-queued-priority-"));
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

describe("queued run priority", () => {
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
      sql`TRUNCATE heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, activity_log, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("claims the newest queued run first so fresh wakeups supersede stale queue backlog", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const olderWakeupId = randomUUID();
    const newerWakeupId = randomUUID();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const olderCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const newerCreatedAt = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priority Tester",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values([
      {
        id: olderWakeupId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "stale_test_wakeup",
        payload: { taskKey: "older-task" },
        status: "queued",
        requestedAt: olderCreatedAt,
        createdAt: olderCreatedAt,
        updatedAt: olderCreatedAt,
      },
      {
        id: newerWakeupId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "fresh_test_wakeup",
        payload: { taskKey: "newer-task" },
        status: "queued",
        requestedAt: newerCreatedAt,
        createdAt: newerCreatedAt,
        updatedAt: newerCreatedAt,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: olderWakeupId,
        contextSnapshot: { taskKey: "older-task" },
        createdAt: olderCreatedAt,
        updatedAt: olderCreatedAt,
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: newerWakeupId,
        contextSnapshot: { taskKey: "newer-task" },
        createdAt: newerCreatedAt,
        updatedAt: newerCreatedAt,
      },
    ]);

    await db
      .update(agentWakeupRequests)
      .set({ runId: olderRunId })
      .where(eq(agentWakeupRequests.id, olderWakeupId));
    await db
      .update(agentWakeupRequests)
      .set({ runId: newerRunId })
      .where(eq(agentWakeupRequests.id, newerWakeupId));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const claimedNewerRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, newerRunId))
      .then((rows) => rows[0] ?? null);
    const stillQueuedOlderRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, olderRunId))
      .then((rows) => rows[0] ?? null);

    expect(claimedNewerRun?.status).toBe("running");
    expect(stillQueuedOlderRun?.status).toBe("queued");

    const claimedWakeup = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, newerWakeupId))
      .then((rows) => rows[0] ?? null);
    const queuedWakeup = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, olderWakeupId))
      .then((rows) => rows[0] ?? null);

    expect(claimedWakeup?.status).toBe("claimed");
    expect(queuedWakeup?.status).toBe("queued");

    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        error: "test cleanup",
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, newerRunId), eq(heartbeatRuns.status, "running")));
  });
});
