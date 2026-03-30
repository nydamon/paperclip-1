import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";

/**
 * Labels that exempt an issue from the QA gate.
 * Matched case-insensitively against the issue's label names.
 */
const SKIP_LABELS = new Set([
  "no-code",
  "research",
  "docs",
  "backlog",
  "ops",
  "operations",
  "incident",
  "rca",
  "postmortem",
  "policy",
  "process",
  "ci",
  "ci/cd",
]);

const NON_CODE_TEXT_PATTERNS: RegExp[] = [
  /\bstale\b.*\b(duplicate|ci|ci\/cd|pipeline|operational)\b/i,
  /\bstale[-\s]?(operational|ci\/?cd)\b/i,
  /\b(incident|rca|postmortem)\b/i,
  /\b(policy|process)\b.*\b(doc|docs|documentation|cleanup)\b/i,
];

/**
 * Pattern that constitutes a QA pass: a comment body containing "@qa-agent PASS"
 * (case-insensitive, allowing whitespace between the mention and the word PASS).
 */
const QA_PASS_PATTERN = /@qa-agent\s+pass/i;

/**
 * Error message posted as a comment when the gate blocks a done transition.
 */
export const BLOCK_COMMENT =
  "**QA gate:** no `@qa-agent PASS` comment found. Request review from @qa-agent before marking done.";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${manifest.displayName} v${manifest.version} setup complete`);

    ctx.events.on("issue.updated", async (event) => {
      // Only handle issue entities
      if (event.entityType !== "issue" || !event.entityId) return;

      // Early-exit: only act when the updated field is status → done.
      // The server includes changed fields in the payload, so we can avoid
      // a round-trip fetch for unrelated updates.
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.status !== "done") return;

      // Board-user bypass: admins/humans can always mark done without QA.
      if (event.actorType === "user") return;

      const issueId = event.entityId;
      const companyId = event.companyId;

      // Fetch the full issue to confirm current status and inspect labels.
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue || issue.status !== "done") {
        // Already changed by another actor or not found — nothing to do.
        return;
      }

      // Label-based bypass: skip gate for non-code-delivery issue types.
      const issueLabels = (issue.labels ?? []).map((l: { name: string }) => l.name.toLowerCase());
      if (issueLabels.some((l: string) => SKIP_LABELS.has(l))) return;

      // Text-based bypass for stale/operational cleanup tickets that may not carry labels yet.
      const searchableText = `${issue.title ?? ""}\n${issue.description ?? ""}`;
      if (NON_CODE_TEXT_PATTERNS.some((pattern) => pattern.test(searchableText))) return;

      // Check for a qualifying @qa-agent PASS comment.
      const comments = await ctx.issues.listComments(issueId, companyId);
      const hasPass = comments.some((c) => QA_PASS_PATTERN.test(c.body));
      if (hasPass) return;

      // No PASS found: revert to in_review and post a blocking comment.
      ctx.logger.info("QA gate: blocking done transition — no @qa-agent PASS found", {
        issueId,
        companyId,
        identifier: issue.identifier ?? issueId,
      });

      await ctx.issues.update(issueId, { status: "in_review" }, companyId);
      await ctx.issues.createComment(issueId, BLOCK_COMMENT, companyId);
    });
  },

  async onHealth() {
    return { status: "ok", message: `${manifest.displayName} is active` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
