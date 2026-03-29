import { describe, expect, it } from "vitest";
import { normalizeAgentMentionToken } from "../services/issues.ts";
import { normalizeAgentUrlKey } from "@paperclipai/shared";

const MENTION_RE = /\B@([^\s@,!?.]+)/g;

function extractTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    const normalized = normalizeAgentMentionToken(m[1]);
    if (normalized) tokens.add(normalized.toLowerCase());
  }
  return tokens;
}

function matchAgents(
  tokens: Set<string>,
  agents: Array<{ id: string; name: string }>,
): string[] {
  const resolved = new Set<string>();
  for (const agent of agents) {
    if (tokens.has(agent.name.toLowerCase())) {
      resolved.add(agent.id);
      continue;
    }
    const agentUrlKey = normalizeAgentUrlKey(agent.name);
    if (agentUrlKey && tokens.has(agentUrlKey)) {
      resolved.add(agent.id);
    }
  }
  return [...resolved];
}

describe("findMentionedAgents urlKey matching", () => {
  const fleet = [
    { id: "a1", name: "CEO" },
    { id: "a2", name: "CTO" },
    { id: "a3", name: "QA Agent" },
    { id: "a4", name: "Senior Claude Code Engineer" },
    { id: "a5", name: "Monitor" },
    { id: "a6", name: "Alfred" },
    { id: "a7", name: "Senior Platform Engineer" },
  ];

  it("matches single-token agent names via @Name", () => {
    const tokens = extractTokens("cc @CEO and @Monitor please review");
    const matched = matchAgents(tokens, fleet);
    expect(matched).toContain("a1");
    expect(matched).toContain("a5");
    expect(matched).toHaveLength(2);
  });

  it("matches multi-word agent names via @url-key", () => {
    const tokens = extractTokens("@qa-agent should look at this");
    const matched = matchAgents(tokens, fleet);
    expect(matched).toContain("a3");
  });

  it("matches Senior Claude Code Engineer via @senior-claude-code-engineer", () => {
    const tokens = extractTokens("@senior-claude-code-engineer ping");
    const matched = matchAgents(tokens, fleet);
    expect(matched).toContain("a4");
  });

  it("matches Senior Platform Engineer via @senior-platform-engineer", () => {
    const tokens = extractTokens("@senior-platform-engineer fix this");
    const matched = matchAgents(tokens, fleet);
    expect(matched).toContain("a7");
  });

  it("does not match partial urlKey prefixes", () => {
    const tokens = extractTokens("@senior this should not match");
    const matched = matchAgents(tokens, fleet);
    expect(matched).toHaveLength(0);
  });

  it("matches both name and urlKey for single-word agents", () => {
    const byName = matchAgents(extractTokens("@Alfred"), fleet);
    const byKey = matchAgents(extractTokens("@alfred"), fleet);
    expect(byName).toContain("a6");
    expect(byKey).toContain("a6");
  });

  it("handles multiple urlKey mentions in one body", () => {
    const tokens = extractTokens("@qa-agent @senior-claude-code-engineer @senior-platform-engineer team up");
    const matched = matchAgents(tokens, fleet);
    expect(matched.sort()).toEqual(["a3", "a4", "a7"]);
  });

  it("does not case-sensitively fail on urlKey matching", () => {
    const tokens = extractTokens("@QA-Agent should work too");
    const matched = matchAgents(tokens, fleet);
    expect(matched).toContain("a3");
  });

  it("returns empty when no agents match", () => {
    const tokens = extractTokens("@nonexistent-agent");
    const matched = matchAgents(tokens, fleet);
    expect(matched).toHaveLength(0);
  });
});
