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

  it("does NOT recover agent whose last run finished less than 60s ago", async () => {
    const { agentId } = await seedAgent({
      status: "error",
      lastRunErrorCode: "process_lost",
      lastRunFinishedAt: new Date(Date.now() - 30_000), // 30s ago — too recent
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
});
