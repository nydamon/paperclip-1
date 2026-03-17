import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.ops-automations";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Ops Automations",
  description:
    "Auto-unblock issues, auto-route push tasks, monitor agent health, and sweep unassigned push tasks.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  jobs: [
    {
      jobKey: "health-monitor",
      displayName: "Agent Health Monitor",
      description:
        "Detects idle agents with stalled in-progress tasks and creates alert issues for the CEO.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "batch-push-sweep",
      displayName: "Batch Push Sweep",
      description:
        "Finds unassigned push-related tasks and batch-assigns them to the Senior Platform Engineer.",
      schedule: "*/30 * * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      autoUnblockEnabled: {
        type: "boolean",
        title: "Enable Auto-Unblock",
        description:
          "Automatically move blocked issues to todo when all referenced blockers are done.",
        default: true,
      },
      pushAutoRouteEnabled: {
        type: "boolean",
        title: "Enable Push Auto-Route",
        description:
          "Automatically assign push-related issues to the Senior Platform Engineer.",
        default: true,
      },
      healthMonitorEnabled: {
        type: "boolean",
        title: "Enable Agent Health Monitor",
        description:
          "Create alert issues when idle agents have >3 stalled in-progress tasks.",
        default: true,
      },
      batchPushSweepEnabled: {
        type: "boolean",
        title: "Enable Batch Push Sweep",
        description:
          "Periodically assign unassigned push tasks to the Senior Platform Engineer.",
        default: true,
      },
    },
  },
};

export default manifest;
