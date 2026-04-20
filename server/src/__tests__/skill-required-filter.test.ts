import { describe, expect, it } from "vitest";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";

function makeEntry(key: string, required: boolean) {
  return { key, runtimeName: key.split("/").pop() ?? key, required };
}

describe("skill required filtering", () => {
  const allBundledEntries = [
    makeEntry("paperclipai/paperclip/paperclip", true),
    makeEntry("paperclipai/paperclip/capability-check", true),
    makeEntry("paperclipai/paperclip/issue-attachments", true),
    makeEntry("paperclipai/paperclip/para-memory-files", true),
    makeEntry("paperclipai/paperclip/dogfood", true),
    makeEntry("paperclipai/paperclip/composio-heygen", true),
    makeEntry("paperclipai/paperclip/paperclip-create-agent", true),
    makeEntry("agricidaniel/claude-seo/seo", false),
    makeEntry("wondelai/skills/ux-heuristics", false),
  ];

  it("without explicit prefs, returns only required skills", () => {
    const config = {};
    const result = resolvePaperclipDesiredSkillNames(config, allBundledEntries);
    const requiredKeys = allBundledEntries.filter(e => e.required).map(e => e.key);
    expect(result).toEqual(expect.arrayContaining(requiredKeys));
    expect(result).not.toContain("agricidaniel/claude-seo/seo");
  });

  it("with explicit prefs, returns required + desired only", () => {
    const config = {
      paperclipSkillSync: {
        desiredSkills: ["agricidaniel/claude-seo/seo", "wondelai/skills/ux-heuristics"],
      },
    };
    const result = resolvePaperclipDesiredSkillNames(config, allBundledEntries);
    const requiredKeys = allBundledEntries.filter(e => e.required).map(e => e.key);
    expect(result).toEqual(expect.arrayContaining(requiredKeys));
    expect(result).toContain("agricidaniel/claude-seo/seo");
    expect(result).toContain("wondelai/skills/ux-heuristics");
  });
});

describe("core-only required filtering", () => {
  const coreOnlyEntries = [
    makeEntry("paperclipai/paperclip/paperclip", true),
    makeEntry("paperclipai/paperclip/capability-check", true),
    makeEntry("paperclipai/paperclip/issue-attachments", true),
    makeEntry("paperclipai/paperclip/para-memory-files", true),
    makeEntry("paperclipai/paperclip/dogfood", false),
    makeEntry("paperclipai/paperclip/composio-heygen", false),
    makeEntry("paperclipai/paperclip/paperclip-create-agent", false),
    makeEntry("agricidaniel/claude-seo/seo", false),
  ];

  it("without explicit prefs, returns only 4 core skills", () => {
    const config = {};
    const result = resolvePaperclipDesiredSkillNames(config, coreOnlyEntries);
    expect(result).toHaveLength(4);
    expect(result).toEqual(expect.arrayContaining([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/capability-check",
      "paperclipai/paperclip/issue-attachments",
      "paperclipai/paperclip/para-memory-files",
    ]));
    expect(result).not.toContain("paperclipai/paperclip/dogfood");
    expect(result).not.toContain("paperclipai/paperclip/composio-heygen");
    expect(result).not.toContain("paperclipai/paperclip/paperclip-create-agent");
  });

  it("with explicit prefs, includes core + desired but not other bundled", () => {
    const config = {
      paperclipSkillSync: {
        desiredSkills: ["agricidaniel/claude-seo/seo"],
      },
    };
    const result = resolvePaperclipDesiredSkillNames(config, coreOnlyEntries);
    expect(result).toHaveLength(5);
    expect(result).toContain("paperclipai/paperclip/paperclip");
    expect(result).toContain("agricidaniel/claude-seo/seo");
    expect(result).not.toContain("paperclipai/paperclip/dogfood");
  });

  it("agent can explicitly opt in to non-core bundled skills", () => {
    const config = {
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/dogfood", "paperclipai/paperclip/paperclip-create-agent"],
      },
    };
    const result = resolvePaperclipDesiredSkillNames(config, coreOnlyEntries);
    expect(result).toHaveLength(6);
    expect(result).toContain("paperclipai/paperclip/dogfood");
    expect(result).toContain("paperclipai/paperclip/paperclip-create-agent");
    expect(result).not.toContain("paperclipai/paperclip/composio-heygen");
  });
});
