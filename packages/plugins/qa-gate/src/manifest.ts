import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.qa-gate";
export const PLUGIN_VERSION = "0.1.1";

/**
 * QA Gate plugin manifest.
 *
 * Intercepts issue.updated events and blocks done status transitions on
 * code-delivery issues unless a "@qa-agent PASS" comment exists in the thread.
 *
 * Bypass rules:
 * - Board users (actorType === "user") always bypass the gate.
 * - Issues labelled no-code/research/docs/backlog or operational labels
 *   (ops/incident/rca/policy/process/ci) bypass the gate.
 * - Stale operational cleanup tickets (e.g. stale CI/CD duplicates) also bypass.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "QA Gate",
  description:
    "Blocks 'done' status transitions on code-delivery issues unless a @qa-agent PASS comment exists. Board users and non-code operational tickets (label or stale-ops text signals) bypass the gate.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issue.comments.read",
    "issues.update",
    "issue.comments.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
