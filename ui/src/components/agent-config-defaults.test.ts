import { describe, expect, it } from "vitest";
import { buildClaudeLocalConfig } from "@paperclipai_dld/adapter-claude-local/ui";
import { defaultCreateValues } from "./agent-config-defaults.js";

describe("defaultCreateValues", () => {
  it("defaults claude_local agents to skipping permission prompts", () => {
    const config = buildClaudeLocalConfig({
      ...defaultCreateValues,
      adapterType: "claude_local",
    });

    expect(defaultCreateValues.dangerouslySkipPermissions).toBe(true);
    expect(config.dangerouslySkipPermissions).toBe(true);
  });
});
