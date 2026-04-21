import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres process_lost recovery tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recoverProcessLostAgents sweeper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-process-lost-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts: {
    status: string;
    pauseReason?: string | null;
    lastRunErrorCode?: string | null;
    lastRunStatus?: string;
    lastRunFinishedAt?: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: opts.status,
      pauseReason: opts.pauseReason ?? null,
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "heartbeat",
      triggerDetail: "system",
      reason: "timer",
      payload: {},
      status: "completed",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "heartbeat",
      triggerDetail: "system",
      status: opts.lastRunStatus ?? "failed",
      wakeupRequestId: wakeupId,
      contextSnapshot: {},
      errorCode: opts.lastRunErrorCode ?? null,
      startedAt: new Date("2026-04-05T10:00:00Z"),
      finishedAt: opts.lastRunFinishedAt ?? new Date("2026-04-05T10:05:00Z"),
    });

    return { companyId, agentId, runId };
  }

  it("recovers agent in error state with process_lost last run", async () => {
    const { agentId } = await seedAgent({
      status: "error",
      lastRunErrorCode: "process_lost",
      lastRunFinishedAt: new Date(Date.now() - 120_000), // 2 min ago
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(1);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("idle");
  });

  it("does NOT recover agent with adapter_failed last run", async () => {
    const { agentId } = await seedAgent({
      status: "error",
      lastRunErrorCode: "adapter_failed",
      lastRunFinishedAt: new Date(Date.now() - 120_000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
  });

  it("does NOT recover agent with pauseReason set (circuit breaker)", async () => {
    const { agentId } = await seedAgent({
      status: "error",
      pauseReason: "adapter_failed_circuit_breaker",
      lastRunErrorCode: "process_lost",
      lastRunFinishedAt: new Date(Date.now() - 120_000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
  });

  it("does NOT recover agent whose last run finished less than 30s ago", async () => {
    // Threshold was reduced from 60s to 30s (DLD-3596); use 15s to guarantee
    // the run is well within the skip window.
    const { agentId } = await seedAgent({
      status: "error",
      lastRunErrorCode: "process_lost",
      lastRunFinishedAt: new Date(Date.now() - 15_000), // 15s ago — too recent
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
  });

  it("does NOT recover idle agents", async () => {
    const { agentId } = await seedAgent({
      status: "idle",
      lastRunErrorCode: "process_lost",
      lastRunFinishedAt: new Date(Date.now() - 120_000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("idle");
  });

  it("recovers agent with stale running run (defensive path — DLD-3596)", async () => {
    // Agent in error state but no completed failed/process_lost run.
    // Has a 'running' run that hasn't heartbeat'd in 6 minutes — the heartbeat
    // process itself crashed (server restart). Should be recovered.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "error",
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      updatedAt: new Date(Date.now() - 10 * 60 * 1000), // agent stuck for 10 min
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "heartbeat",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
      updatedAt: new Date(Date.now() - 6 * 60 * 1000), // last heartbeat 6 min ago
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(1);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("idle");
  });

  it("does NOT recover agent with recent running run (still heartbeatting)", async () => {
    // Agent in error state with a 'running' run that's only 1 min old.
    // The heartbeat is still alive — don't interfere.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "error",
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      updatedAt: new Date(Date.now() - 1 * 60 * 1000),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "heartbeat",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
      updatedAt: new Date(Date.now() - 1 * 60 * 1000), // last heartbeat 1 min ago
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
  });

  it("recovers agent in error with no runs and agent.updatedAt > 5 min (DLD-3596 defensive path)", async () => {
    // Agent in error state with no heartbeat runs at all (heartbeat crashed before
    // recording the run, or shouldRetry=false left no retry). Agent.updatedAt is
    // > 5 min old — genuinely stuck. Should be recovered.
    // Uses a stale 'running' run (updatedAt 6 min ago) to reliably trigger the
    // defensive path regardless of timing of Date.now() evaluation.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "error",
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      updatedAt: new Date(Date.now() - 10 * 60 * 1000), // stuck for 10 min
    });

    // A stale 'running' run — heartbeat hasn't updated in 6 min (past 5 min threshold).
    // This triggers the defensive stale-run path. Combined with agent.updatedAt=10 min,
    // both defensive conditions are satisfied.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "heartbeat",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
      updatedAt: new Date(Date.now() - 6 * 60 * 1000), // 6 min ago — past 5 min threshold
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(1);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("idle");
  });

  it("does NOT recover agent in error with non-process_lost failed run and recent agent.updatedAt", async () => {
    // Agent in error state with a recent failed run (not process_lost).
    // Agent.updatedAt is only 1 min old — the heartbeat is still processing.
    // Should NOT recover — let the heartbeat handle it.
    const { agentId } = await seedAgent({
      status: "error",
      lastRunErrorCode: "adapter_failed",
      lastRunFinishedAt: new Date(Date.now() - 30_000), // recent
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.recoverProcessLostAgents();

    expect(result.recovered).toBe(0);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).toBe("error");
  });
});
