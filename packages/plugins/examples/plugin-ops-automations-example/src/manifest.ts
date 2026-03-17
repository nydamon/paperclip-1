import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.ops-automations";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Ops Automations",
  description:
    "Auto-unblock issues when all referenced blockers resolve; auto-route push tasks to the Senior Platform Engineer.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
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
    },
  },
};

export default manifest;
