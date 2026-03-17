import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

// ── mock services ────────────────────────────────────────────────
const mockAgentSvc = vi.hoisted(() => ({
  getById: vi.fn(),
  createApiKey: vi.fn(),
  listKeys: vi.fn(),
  revokeKey: vi.fn(),
  // stubs for unused deps referenced by agentRoutes
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  orgForCompany: vi.fn(),
  getChainOfCommand: vi.fn(),
  getByUrlKey: vi.fn(),
  rollbackRevision: vi.fn(),
  listRevisions: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentSvc,
  accessService: () => ({ canUser: vi.fn().mockResolvedValue(true) }),
  approvalService: () => ({
    create: vi.fn(),
    resolve: vi.fn(),
    findById: vi.fn(),
    listForCompany: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(),
    getStatus: vi.fn(),
  }),
  issueApprovalService: () => ({
    create: vi.fn(),
    findPendingForIssue: vi.fn(),
  }),
  issueService: () => ({
    getById: vi.fn(),
    getByIdentifier: vi.fn(),
  }),
  secretService: () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

// stub adapter imports that agentRoutes pulls in at module level
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn().mockResolvedValue([]),
}));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));
vi.mock("@paperclipai/adapter-codex-local", () => ({
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX: false,
  DEFAULT_CODEX_LOCAL_MODEL: "codex-mini-latest",
}));
vi.mock("@paperclipai/adapter-cursor-local", () => ({
  DEFAULT_CURSOR_LOCAL_MODEL: "cursor-small",
}));
vi.mock("@paperclipai/adapter-gemini-local", () => ({
  DEFAULT_GEMINI_LOCAL_MODEL: "gemini-2.5-pro",
}));
vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

// Now import the real route after mocks are wired
const { agentRoutes } = await import("../routes/agents.js");

// ── helpers ──────────────────────────────────────────────────────
function createApp(actorType: "board" | "agent" = "board") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actorType === "board") {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    } else {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
      };
    }
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa";
const KEY_ID = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";

// ── tests ────────────────────────────────────────────────────────
describe("agent key routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /api/agents/:id/keys ──────────────────────────────────
  describe("POST /api/agents/:id/keys (create)", () => {
    it("board user can create a key and receives token once", async () => {
      const app = createApp("board");
      mockAgentSvc.createApiKey.mockResolvedValue({
        id: KEY_ID,
        name: "github-actions-prod",
        token: "pcp_abcdef1234567890abcdef1234567890abcdef1234567890",
        createdAt: new Date("2026-03-16T00:00:00Z"),
      });
      mockAgentSvc.getById.mockResolvedValue({
        id: AGENT_ID,
        companyId: "company-1",
        status: "running",
      });

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys`)
        .send({ name: "github-actions-prod" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: KEY_ID,
        name: "github-actions-prod",
      });
      expect(res.body.token).toMatch(/^pcp_/);
      expect(mockAgentSvc.createApiKey).toHaveBeenCalledWith(AGENT_ID, "github-actions-prod");
    });

    it("activity-logs the key creation", async () => {
      const app = createApp("board");
      mockAgentSvc.createApiKey.mockResolvedValue({
        id: KEY_ID,
        name: "ci-key",
        token: "pcp_000000000000000000000000000000000000000000000000",
        createdAt: new Date(),
      });
      mockAgentSvc.getById.mockResolvedValue({
        id: AGENT_ID,
        companyId: "company-1",
        status: "running",
      });

      await request(app)
        .post(`/api/agents/${AGENT_ID}/keys`)
        .send({ name: "ci-key" });

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "agent.key_created",
          entityId: AGENT_ID,
          details: expect.objectContaining({ keyId: KEY_ID, name: "ci-key" }),
        }),
      );
    });

    it("rejects non-board callers with 403", async () => {
      const app = createApp("agent");

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys`)
        .send({ name: "ci-key" });

      expect(res.status).toBe(403);
      expect(mockAgentSvc.createApiKey).not.toHaveBeenCalled();
    });

    it("rejects creation for pending_approval agent with 409", async () => {
      const app = createApp("board");
      mockAgentSvc.createApiKey.mockRejectedValue(
        new HttpError(409, "Cannot create keys for pending approval agents"),
      );

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys`)
        .send({ name: "ci-key" });

      expect(res.status).toBe(409);
    });

    it("rejects creation for terminated agent with 409", async () => {
      const app = createApp("board");
      mockAgentSvc.createApiKey.mockRejectedValue(
        new HttpError(409, "Cannot create keys for terminated agents"),
      );

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys`)
        .send({ name: "ci-key" });

      expect(res.status).toBe(409);
    });

    it("defaults name to 'default' when not provided", async () => {
      const app = createApp("board");
      mockAgentSvc.createApiKey.mockResolvedValue({
        id: KEY_ID,
        name: "default",
        token: "pcp_000000000000000000000000000000000000000000000000",
        createdAt: new Date(),
      });
      mockAgentSvc.getById.mockResolvedValue({
        id: AGENT_ID,
        companyId: "company-1",
        status: "running",
      });

      const res = await request(app)
        .post(`/api/agents/${AGENT_ID}/keys`)
        .send({});

      expect(res.status).toBe(201);
      expect(mockAgentSvc.createApiKey).toHaveBeenCalledWith(AGENT_ID, "default");
    });
  });

  // ── GET /api/agents/:id/keys ───────────────────────────────────
  describe("GET /api/agents/:id/keys (list)", () => {
    it("board user can list keys", async () => {
      const app = createApp("board");
      mockAgentSvc.listKeys.mockResolvedValue([
        { id: KEY_ID, name: "ci-key", createdAt: new Date(), revokedAt: null },
      ]);

      const res = await request(app).get(`/api/agents/${AGENT_ID}/keys`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("ci-key");
    });

    it("rejects non-board callers with 403", async () => {
      const app = createApp("agent");

      const res = await request(app).get(`/api/agents/${AGENT_ID}/keys`);

      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /api/agents/:id/keys/:keyId ─────────────────────────
  describe("DELETE /api/agents/:id/keys/:keyId (revoke)", () => {
    it("board user can revoke a key", async () => {
      const app = createApp("board");
      mockAgentSvc.revokeKey.mockResolvedValue({
        id: KEY_ID,
        revokedAt: new Date(),
      });

      const res = await request(app).delete(
        `/api/agents/${AGENT_ID}/keys/${KEY_ID}`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns 404 when key not found", async () => {
      const app = createApp("board");
      mockAgentSvc.revokeKey.mockResolvedValue(null);

      const res = await request(app).delete(
        `/api/agents/${AGENT_ID}/keys/${KEY_ID}`,
      );

      expect(res.status).toBe(404);
    });

    it("rejects non-board callers with 403", async () => {
      const app = createApp("agent");

      const res = await request(app).delete(
        `/api/agents/${AGENT_ID}/keys/${KEY_ID}`,
      );

      expect(res.status).toBe(403);
    });
  });
});
