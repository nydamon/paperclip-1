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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-expire-locks-"));
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

describe("expireTerminatedRunLocks", () => {
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

  async function seedLockedIssue(runStatus: string, runCreatedAt?: Date) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
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
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: runStatus,
      source: "assignment",
      startedAt: new Date(),
      createdAt: runCreatedAt ?? new Date(),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionLockedAt: new Date(),
      identifier: `${issuePrefix}-1`,
      issueNumber: 1,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("expires lock when run is in terminal state (succeeded)", async () => {
    const { issueId } = await seedLockedIssue("succeeded");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.expireTerminatedRunLocks();
    expect(result.expired).toBe(1);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.executionRunId).toBeNull();
    expect(issue.executionLockedAt).toBeNull();
  });

  it("expires lock when run is in terminal state (failed)", async () => {
    const { issueId } = await seedLockedIssue("failed");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.expireTerminatedRunLocks();
    expect(result.expired).toBe(1);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.executionRunId).toBeNull();
  });

  it("expires lock when run is missing from DB", async () => {
    // Seed an issue with a valid run, then use raw SQL to set a non-existent run ID
    // (bypassing FK via session_replication_role to simulate an orphaned reference)
    const { issueId } = await seedLockedIssue("running");
    const fakeRunId = randomUUID();

    await db.execute(sql`SET session_replication_role = 'replica'`);
    await db.execute(
      sql`UPDATE issues SET execution_run_id = ${fakeRunId} WHERE id = ${issueId}::uuid`,
    );
    await db.execute(sql`SET session_replication_role = 'origin'`);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.expireTerminatedRunLocks();
    expect(result.expired).toBe(1);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.executionRunId).toBeNull();
  });

  it("does NOT expire lock for a running run", async () => {
    const { issueId } = await seedLockedIssue("running");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.expireTerminatedRunLocks();
    expect(result.expired).toBe(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.executionRunId).not.toBeNull();
  });

  it("does NOT expire lock for a recently queued run", async () => {
    // Queued just now — within the 5m threshold
    const { issueId } = await seedLockedIssue("queued", new Date());

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.expireTerminatedRunLocks();
    expect(result.expired).toBe(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.executionRunId).not.toBeNull();
  });

  it("expires lock for a queued run older than 5 minutes", async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
    const { issueId, runId } = await seedLockedIssue("queued", sixMinutesAgo);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.expireTerminatedRunLocks();
    expect(result.expired).toBe(1);

    // Issue lock should be cleared
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.executionRunId).toBeNull();
    expect(issue.executionLockedAt).toBeNull();

    // The stale queued run should be cancelled
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("cancelled");
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toContain("Stale queued run");
  });
});
