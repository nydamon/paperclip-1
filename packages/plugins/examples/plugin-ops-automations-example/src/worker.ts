import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "ops-automations";
const ISSUE_REF_RE = /[A-Z]+-\d+/g;
const PUSH_TITLE_RE = /^Push\s/i;
const SPE_URL_KEY = "senior-platform-engineer";
const SPE_STATE_KEY = "spe-agent-id";
const CEO_URL_KEY = "ceo";
const CEO_STATE_KEY = "ceo-agent-id";
const COMPANY_ID_STATE_KEY = "company-id";
const HEALTH_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const STALLED_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface OpsConfig {
  autoUnblockEnabled?: boolean;
  pushAutoRouteEnabled?: boolean;
  healthMonitorEnabled?: boolean;
  batchPushSweepEnabled?: boolean;
}

async function getConfig(ctx: PluginContext): Promise<OpsConfig> {
  return (await ctx.config.get()) as OpsConfig;
}

/** Persist the companyId so scheduled jobs (which lack event context) can retrieve it. */
async function ensureCompanyId(ctx: PluginContext, companyId: string): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: COMPANY_ID_STATE_KEY },
    companyId,
  );
}

async function getStoredCompanyId(ctx: PluginContext): Promise<string | null> {
  const val = await ctx.state.get({
    scopeKind: "instance",
    stateKey: COMPANY_ID_STATE_KEY,
  });
  return typeof val === "string" && val.length > 0 ? val : null;
}

// ---------------------------------------------------------------------------
// H1 — Auto-Unblock Handler
// ---------------------------------------------------------------------------

async function handleAutoUnblock(
  ctx: PluginContext,
  completedIssueId: string,
  companyId: string,
): Promise<void> {
  // Get the completed issue to find its identifier
  const completedIssue = await ctx.issues.get(completedIssueId, companyId);
  if (!completedIssue?.identifier) return;

  const completedIdentifier = completedIssue.identifier;

  // Find all blocked issues in the company
  const blockedIssues = await ctx.issues.list({
    companyId,
    status: "blocked",
  });

  for (const blocked of blockedIssues) {
    // Scan comment thread for references to the completed issue
    const comments = await ctx.issues.listComments(blocked.id, companyId);

    // Collect all issue identifiers referenced in blocker comments
    const referencedIdentifiers = new Set<string>();
    for (const comment of comments) {
      const matches = comment.body.match(ISSUE_REF_RE);
      if (matches) {
        for (const m of matches) referencedIdentifiers.add(m);
      }
    }

    // Only proceed if the completed issue was actually referenced
    if (!referencedIdentifiers.has(completedIdentifier)) continue;

    // Check if ALL referenced issues are now done
    const otherRefs = [...referencedIdentifiers].filter((r) => r !== completedIdentifier);
    let allDone = true;

    if (otherRefs.length > 0) {
      // Fetch all company issues once and build a lookup by identifier
      const allIssues = await ctx.issues.list({ companyId });
      const byIdentifier = new Map(
        allIssues
          .filter((i) => i.identifier)
          .map((i) => [i.identifier, i]),
      );

      for (const ref of otherRefs) {
        const match = byIdentifier.get(ref);
        if (match && match.status !== "done" && match.status !== "cancelled") {
          allDone = false;
          break;
        }
        // If not found, treat as resolved (external reference or deleted)
      }
    }

    if (allDone) {
      await ctx.issues.update(blocked.id, { status: "todo" }, companyId);
      await ctx.issues.createComment(
        blocked.id,
        `**Auto-unblocked** — all referenced blockers are now resolved (latest: \`${completedIdentifier}\`).`,
        companyId,
      );
      await ctx.activity.log({
        companyId,
        message: `Auto-unblocked ${blocked.identifier ?? blocked.id} after ${completedIdentifier} completed`,
        entityType: "issue",
        entityId: blocked.id,
      });
      ctx.logger.info("Auto-unblocked issue", {
        issueId: blocked.id,
        identifier: blocked.identifier,
        trigger: completedIdentifier,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// H2 — Push Auto-Route Handler
// ---------------------------------------------------------------------------

async function resolveSpeAgentId(
  ctx: PluginContext,
  companyId: string,
): Promise<string | null> {
  // Check cached value first
  const cached = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: SPE_STATE_KEY,
  });
  if (typeof cached === "string" && cached.length > 0) return cached;

  // Look up the agent by urlKey
  const agents = await ctx.agents.list({ companyId });
  const spe = agents.find((a) => a.urlKey === SPE_URL_KEY);
  if (!spe) return null;

  // Cache for future use
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: SPE_STATE_KEY },
    spe.id,
  );
  return spe.id;
}

function isPushTask(title: string): boolean {
  if (PUSH_TITLE_RE.test(title)) return true;
  const lower = title.toLowerCase();
  return (
    lower.includes("push") &&
    (lower.includes("remote") || lower.includes("origin"))
  );
}

async function handlePushAutoRoute(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
): Promise<void> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return;

  // Only route if unassigned and title matches push pattern
  if (issue.assigneeAgentId) return;
  if (!isPushTask(issue.title)) return;

  const speId = await resolveSpeAgentId(ctx, companyId);
  if (!speId) {
    ctx.logger.warn("Push auto-route: Senior Platform Engineer agent not found", { companyId });
    return;
  }

  await ctx.issues.update(issueId, { assigneeAgentId: speId }, companyId);
  await ctx.issues.createComment(
    issueId,
    "Auto-routed to [Senior Platform Engineer](/DLD/agents/senior-platform-engineer) — push tasks require GitHub token access.",
    companyId,
  );
  await ctx.activity.log({
    companyId,
    message: `Auto-routed push task "${issue.title}" to Senior Platform Engineer`,
    entityType: "issue",
    entityId: issueId,
  });
  ctx.logger.info("Push task auto-routed", {
    issueId,
    identifier: issue.identifier,
    speAgentId: speId,
  });
}

// ---------------------------------------------------------------------------
// Agent resolver helpers
// ---------------------------------------------------------------------------

async function resolveCeoAgentId(
  ctx: PluginContext,
  companyId: string,
): Promise<string | null> {
  const cached = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: CEO_STATE_KEY,
  });
  if (typeof cached === "string" && cached.length > 0) return cached;

  const agents = await ctx.agents.list({ companyId });
  const ceo = agents.find((a) => a.urlKey === CEO_URL_KEY);
  if (!ceo) return null;

  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: CEO_STATE_KEY },
    ceo.id,
  );
  return ceo.id;
}

// ---------------------------------------------------------------------------
// H3 — Agent Health Monitor Job
// ---------------------------------------------------------------------------

async function runHealthMonitor(
  ctx: PluginContext,
  _job: PluginJobContext,
): Promise<void> {
  const config = await getConfig(ctx);
  if (config.healthMonitorEnabled === false) return;

  const companyId = await getStoredCompanyId(ctx);
  if (!companyId) {
    ctx.logger.warn("Health monitor: no companyId stored yet — skipping until first event fires");
    return;
  }

  const agents = await ctx.agents.list({ companyId });
  if (agents.length === 0) return;

  const now = Date.now();

  for (const agent of agents) {
    if (agent.status !== "idle") continue;

    // List in_progress issues for this agent
    const inProgressIssues = await ctx.issues.list({
      companyId,
      status: "in_progress",
      assigneeAgentId: agent.id,
    });

    if (inProgressIssues.length <= STALLED_THRESHOLD) continue;

    // Check cooldown via plugin state
    const lastAlertRaw = await ctx.state.get({
      scopeKind: "agent",
      scopeId: agent.id,
      stateKey: "last-health-alert",
    });
    if (typeof lastAlertRaw === "number" && now - lastAlertRaw < HEALTH_ALERT_COOLDOWN_MS) {
      ctx.logger.info("Health alert skipped (cooldown)", {
        agentId: agent.id,
        agentName: agent.name,
      });
      continue;
    }

    // Resolve CEO for alert assignment
    const ceoId = await resolveCeoAgentId(ctx, companyId);
    if (!ceoId) {
      ctx.logger.warn("Health monitor: CEO agent not found", { companyId });
      continue;
    }

    // Create alert issue assigned to CEO
    const alertTitle = `Health Alert: ${agent.name} idle with ${inProgressIssues.length} in-progress tasks`;
    await ctx.issues.create({
      companyId,
      title: alertTitle,
      description: `Agent **${agent.name}** (\`${agent.urlKey}\`) is \`idle\` but has **${inProgressIssues.length}** in-progress tasks.\n\nStalled tasks:\n${inProgressIssues.map((i) => `- \`${i.identifier ?? i.id}\`: ${i.title}`).join("\n")}`,
      priority: "high",
      assigneeAgentId: ceoId,
    });

    // Post comments on stalled tasks
    for (const stalled of inProgressIssues) {
      await ctx.issues.createComment(
        stalled.id,
        `**Health Alert** — Agent \`${agent.name}\` is idle with ${inProgressIssues.length} in-progress tasks. Alert raised for CEO review.`,
        companyId,
      );
    }

    // Record alert timestamp
    await ctx.state.set(
      { scopeKind: "agent", scopeId: agent.id, stateKey: "last-health-alert" },
      now,
    );

    await ctx.activity.log({
      companyId,
      message: `Health alert: ${agent.name} idle with ${inProgressIssues.length} stalled tasks`,
      entityType: "agent",
      entityId: agent.id,
    });

    ctx.logger.info("Health alert created", {
      agentId: agent.id,
      agentName: agent.name,
      stalledCount: inProgressIssues.length,
    });
  }
}

// ---------------------------------------------------------------------------
// H4 — Batch Push Sweep Job
// ---------------------------------------------------------------------------

async function runBatchPushSweep(
  ctx: PluginContext,
  _job: PluginJobContext,
): Promise<void> {
  const config = await getConfig(ctx);
  if (config.batchPushSweepEnabled === false) return;

  const companyId = await getStoredCompanyId(ctx);
  if (!companyId) {
    ctx.logger.warn("Batch push sweep: no companyId stored yet — skipping until first event fires");
    return;
  }

  // Find all todo issues
  const todoIssues = await ctx.issues.list({
    companyId,
    status: "todo",
  });

  // Filter for push-pattern titles that are unassigned
  const unassignedPush = todoIssues.filter(
    (i) => !i.assigneeAgentId && isPushTask(i.title),
  );

  if (unassignedPush.length === 0) return;

  const speId = await resolveSpeAgentId(ctx, companyId);
  if (!speId) {
    ctx.logger.warn("Batch push sweep: Senior Platform Engineer agent not found", { companyId });
    return;
  }

  // Batch-assign all matching tasks
  for (const issue of unassignedPush) {
    await ctx.issues.update(issue.id, { assigneeAgentId: speId }, companyId);
  }

  await ctx.activity.log({
    companyId,
    message: `Batch push sweep: assigned ${unassignedPush.length} push task(s) to Senior Platform Engineer`,
    metadata: {
      issueIds: unassignedPush.map((i) => i.id),
      identifiers: unassignedPush.map((i) => i.identifier).filter(Boolean),
    },
  });

  ctx.logger.info("Batch push sweep complete", {
    assignedCount: unassignedPush.length,
    speAgentId: speId,
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    // H1 — Auto-Unblock: fires when any issue transitions to done
    ctx.events.on("issue.updated", async (event) => {
      await ensureCompanyId(ctx, event.companyId);

      const config = await getConfig(ctx);
      if (config.autoUnblockEnabled === false) return;

      const payload = event.payload as Record<string, unknown> | undefined;
      // Only act when status changed to "done"
      if (payload?.status !== "done") return;

      const issueId = event.entityId;
      if (!issueId) return;

      await handleAutoUnblock(ctx, issueId, event.companyId);
    });

    // H2 — Push Auto-Route: fires when a new issue is created
    ctx.events.on("issue.created", async (event) => {
      await ensureCompanyId(ctx, event.companyId);

      const config = await getConfig(ctx);
      if (config.pushAutoRouteEnabled === false) return;

      const issueId = event.entityId;
      if (!issueId) return;

      await handlePushAutoRoute(ctx, issueId, event.companyId);
    });

    // H3 — Agent Health Monitor: scheduled every 15 minutes
    ctx.jobs.register("health-monitor", async (job) => {
      await runHealthMonitor(ctx, job);
    });

    // H4 — Batch Push Sweep: scheduled every 30 minutes
    ctx.jobs.register("batch-push-sweep", async (job) => {
      await runBatchPushSweep(ctx, job);
    });

    ctx.logger.info(`${PLUGIN_NAME} plugin setup complete`);
  },

  async onHealth() {
    return { status: "ok", message: "Ops automations plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
