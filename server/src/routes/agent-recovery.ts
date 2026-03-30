import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  managerRecoveryActionSchema,
  managerRollbackConfigSchema,
} from "@paperclipai/shared";
import {
  agentService,
  heartbeatService,
  logActivity,
} from "../services/index.js";
import { assertCompanyAccess, assertManagerOf, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function agentRecoveryRoutes(db: Db) {
  const router = Router();
  const svc = agentService(db);
  const heartbeat = heartbeatService(db);

  async function loadAndAuthorizeAgent(req: Request, id: string) {
    const agent = await svc.getById(id);
    if (!agent) {
      return { error: "Agent not found", status: 404, agent: null };
    }
    try {
      assertCompanyAccess(req, agent.companyId);
    } catch {
      return { error: "Forbidden: no company access", status: 403, agent: null };
    }
    try {
      await assertManagerOf(req, db, id);
    } catch (e) {
      return { error: (e as Error).message, status: 403, agent: null };
    }
    return { error: null, status: 200, agent };
  }

  router.post("/agents/:id/recover/pause", validate(managerRecoveryActionSchema), async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadAndAuthorizeAgent(req, id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const agent = loaded.agent!;

    if (agent.status === "terminated") {
      return res.status(422).json({ error: "Cannot pause a terminated agent" });
    }

    const paused = await svc.pause(id, "manual");
    if (!paused) {
      return res.status(404).json({ error: "Agent not found" });
    }

    await heartbeat.cancelActiveForAgent(id);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.manager_paused",
      entityType: "agent",
      entityId: agent.id,
      details: { reason: req.body.reason ?? null },
    });

    res.json({ status: "paused", agent: paused });
  });

  router.post("/agents/:id/recover/resume", validate(managerRecoveryActionSchema), async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadAndAuthorizeAgent(req, id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const agent = loaded.agent!;

    if (agent.status === "terminated") {
      return res.status(422).json({ error: "Cannot resume a terminated agent" });
    }
    if (agent.status === "pending_approval") {
      return res.status(422).json({ error: "Cannot resume a pending-approval agent" });
    }

    const resumed = await svc.resume(id);
    if (!resumed) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.manager_resumed",
      entityType: "agent",
      entityId: agent.id,
      details: { reason: req.body.reason ?? null },
    });

    res.json({ status: "resumed", agent: resumed });
  });

  router.post("/agents/:id/recover/retry-heartbeat", validate(managerRecoveryActionSchema), async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadAndAuthorizeAgent(req, id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const agent = loaded.agent!;

    if (agent.status !== "paused" && agent.status !== "idle") {
      return res.status(422).json({
        error: `Cannot trigger heartbeat retry for agent in '${agent.status}' status. Pause the agent first.`,
      });
    }

    const actor = getActorInfo(req);
    const run = await heartbeat.wakeup(id, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: req.body.reason ?? "manager_recovery_retry",
      payload: null,
      idempotencyKey: null,
      requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
      requestedByActorId: actor.actorId,
      contextSnapshot: {
        triggeredBy: "manager_recovery",
        actorId: actor.actorId,
      },
    });

    if (!run) {
      return res.status(409).json({
        error: "No active run slot available; the agent may already have a queued or running heartbeat",
      });
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.manager_retry_triggered",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id, reason: req.body.reason ?? null },
    });

    res.json({ status: "retry_scheduled", run });
  });

  router.post("/agents/:id/recover/reset-session", validate(managerRecoveryActionSchema), async (req, res) => {
    const id = req.params.id as string;
    const loaded = await loadAndAuthorizeAgent(req, id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const agent = loaded.agent!;

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;

    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.manager_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null, reason: req.body.reason ?? null },
    });

    res.json(state);
  });

  router.post("/agents/:id/recover/rollback-config", validate(managerRollbackConfigSchema), async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.body.revisionId as string;
    const loaded = await loadAndAuthorizeAgent(req, id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const agent = loaded.agent!;

    const actor = getActorInfo(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    if (!updated) {
      return res.status(404).json({ error: "Revision not found" });
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.manager_config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId, reason: req.body.reason ?? null },
    });

    res.json(updated);
  });

  return router;
}
