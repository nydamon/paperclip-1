import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-comment-cooldown-"));
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

describe("comment retrigger cooldown", () => {
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
      // @ts-expect-error — raw SQL for test cleanup
      `TRUNCATE issues, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, agent_runtime_state, agent_task_sessions, company_skills, agents, companies CASCADE`,
    );
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedAgentAndIssue() {
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
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: true },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "in_progress",
      assigneeAgentId: agentId,
      gateBlockCount: 0,
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
    });

    return { companyId, agentId, issueId };
  }

  async function insertCompletedWakeupRun(
    agentId: string,
    companyId: string,
    issueId: string,
    finishedAt: Date,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      agentId,
      companyId,
      status: "succeeded",
      invocationSource: "automation",
      contextSnapshot: { issueId },
      finishedAt,
      createdAt: new Date(finishedAt.getTime() - 60_000),
    });
    return runId;
  }

  it("skips comment retrigger wakeup when a recent wakeup run exists", async () => {
    const { agentId, issueId, companyId } = await seedAgentAndIssue();

    // Insert a wakeup run that finished 5 minutes ago (within 15-min cooldown)
    await insertCompletedWakeupRun(
      agentId,
      companyId,
      issueId,
      new Date(Date.now() - 5 * 60_000),
    );

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_retrigger",
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    expect(result).toBeNull();

    const wakeups = await db.select().from(agentWakeupRequests);
    const skipped = wakeups.find((w) => w.reason?.startsWith("comment_retrigger_cooldown"));
    expect(skipped).toBeTruthy();
    expect(skipped!.status).toBe("skipped");
  });

  it("allows comment retrigger wakeup when no recent wakeup run exists", async () => {
    const { agentId, issueId, companyId } = await seedAgentAndIssue();

    // Insert a wakeup run that finished 20 minutes ago (outside 15-min cooldown)
    await insertCompletedWakeupRun(
      agentId,
      companyId,
      issueId,
      new Date(Date.now() - 20 * 60_000),
    );

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_retrigger",
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    // Should NOT be skipped — the recent run is outside the cooldown window
    expect(result).not.toBeNull();
  });

  it("does NOT skip issue_comment_mentioned during cooldown (mentions bypass cooldown)", async () => {
    const { agentId, issueId, companyId } = await seedAgentAndIssue();

    // Insert a wakeup run that finished 3 minutes ago
    await insertCompletedWakeupRun(
      agentId,
      companyId,
      issueId,
      new Date(Date.now() - 3 * 60_000),
    );

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    // @mentions are deliberate requests for action — they should always
    // wake the target agent regardless of recent activity.
    expect(result).not.toBeNull();
  });

  it("does not affect non-comment wakeup reasons", async () => {
    const { agentId, issueId, companyId } = await seedAgentAndIssue();

    // Insert a very recent wakeup run (1 minute ago)
    await insertCompletedWakeupRun(
      agentId,
      companyId,
      issueId,
      new Date(Date.now() - 60_000),
    );

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "assignment",
      contextSnapshot: { issueId },
    });

    // Assignment wakeups should not be affected by comment cooldown
    expect(result).not.toBeNull();
  });
});
