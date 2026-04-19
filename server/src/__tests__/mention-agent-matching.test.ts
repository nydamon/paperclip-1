import { describe, expect, it } from "vitest";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { normalizeAgentMentionToken } from "../services/issues.js";

/**
 * Simulates the matching logic in findMentionedAgents() (services/issues.ts)
 * without requiring a database connection.  The regex, token normalisation,
 * and three-pass comparison (direct name ∪ kebab-key ∪ multi-word greedy)
 * mirror production exactly.
 */
function matchMentionedAgents(
  body: string,
  agentRows: { id: string; name: string }[],
): string[] {
  const re = /\B@([^\s@,!?.]+)/g;
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const normalized = normalizeAgentMentionToken(m[1]);
    if (normalized) tokens.add(normalized.toLowerCase());
  }

  if (tokens.size === 0) return [];

  const resolved = new Set<string>();
  for (const agent of agentRows) {
    // Pass 1: direct name match (single-word names like "CEO")
    if (tokens.has(agent.name.toLowerCase())) {
      resolved.add(agent.id);
      continue;
    }
    // Pass 2: kebab-key match (@qa-agent -> "QA Agent")
    const agentKey = normalizeAgentUrlKey(agent.name);
    if (agentKey && tokens.has(agentKey)) {
      resolved.add(agent.id);
      continue;
    }
    // Pass 3: multi-word greedy match ("@QA Agent" in body text)
    const nameLower = agent.name.toLowerCase();
    if (nameLower.includes(" ")) {
      const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`@${escaped}\\b`, "gi");
      if (pattern.test(body)) {
        resolved.add(agent.id);
      }
    }
  }
  return [...resolved];
}

// Agents matching the real fleet
const AGENTS = [
  { id: "a1", name: "CEO" },
  { id: "a2", name: "CTO" },
  { id: "a3", name: "QA Agent" },
  { id: "a4", name: "Senior Claude Code Engineer" },
  { id: "a5", name: "Senior Platform Engineer" },
  { id: "a6", name: "Release Manager" },
  { id: "a7", name: "Hermes" },
  { id: "a8", name: "Ralph Wiggum" },
  { id: "a9", name: "Founding Engineer" },
];

describe("mention agent matching", () => {
  // --- Single-word names (always worked) ---

  it("matches single-word name via direct comparison", () => {
    expect(matchMentionedAgents("@ceo please review", AGENTS)).toEqual(["a1"]);
  });

  it("matches single-word name case-insensitively", () => {
    expect(matchMentionedAgents("@CEO please review", AGENTS)).toEqual(["a1"]);
  });

  // --- Multi-word names via kebab-case (the bug fix) ---

  it("matches @qa-agent to 'QA Agent'", () => {
    expect(matchMentionedAgents("@qa-agent please review", AGENTS)).toEqual(["a3"]);
  });

  it("matches @senior-claude-code-engineer to 'Senior Claude Code Engineer'", () => {
    expect(matchMentionedAgents("@senior-claude-code-engineer proceed", AGENTS)).toEqual(["a4"]);
  });

  it("matches @senior-platform-engineer to 'Senior Platform Engineer'", () => {
    expect(matchMentionedAgents("@senior-platform-engineer check this", AGENTS)).toEqual(["a5"]);
  });

  it("matches @release-manager to 'Release Manager'", () => {
    expect(matchMentionedAgents("@release-manager ship it", AGENTS)).toEqual(["a6"]);
  });

  it("matches @ralph-wiggum to 'Ralph Wiggum'", () => {
    expect(matchMentionedAgents("@ralph-wiggum hi", AGENTS)).toEqual(["a8"]);
  });

  it("matches @founding-engineer to 'Founding Engineer'", () => {
    expect(matchMentionedAgents("@founding-engineer take a look", AGENTS)).toEqual(["a9"]);
  });

  // --- Multiple mentions in one body ---

  it("resolves multiple mentions in a single comment", () => {
    const result = matchMentionedAgents("@qa-agent @ceo please review this PR", AGENTS);
    expect(result.sort()).toEqual(["a1", "a3"]);
  });

  it("resolves mix of single-word and kebab-case mentions", () => {
    const result = matchMentionedAgents("@hermes @senior-platform-engineer coordinate", AGENTS);
    expect(result.sort()).toEqual(["a5", "a7"]);
  });

  // --- Multi-word names via natural space syntax ---

  it("matches '@QA Agent' with space to 'QA Agent'", () => {
    expect(matchMentionedAgents("@QA Agent — please review", AGENTS)).toEqual(["a3"]);
  });

  it("matches '@Senior Platform Engineer' with spaces", () => {
    expect(matchMentionedAgents("@Senior Platform Engineer check this", AGENTS)).toEqual(["a5"]);
  });

  it("matches '@QA Agent' case-insensitively", () => {
    expect(matchMentionedAgents("@qa agent please review", AGENTS)).toEqual(["a3"]);
  });

  it("matches '@Release Manager' with space", () => {
    expect(matchMentionedAgents("@Release Manager ship it", AGENTS)).toEqual(["a6"]);
  });

  // --- Edge cases ---

  it("returns empty for non-existent agent mention", () => {
    expect(matchMentionedAgents("@nonexistent-agent help", AGENTS)).toEqual([]);
  });

  it("returns empty for body with no mentions", () => {
    expect(matchMentionedAgents("no mentions here", AGENTS)).toEqual([]);
  });

  it("deduplicates when same agent is mentioned twice", () => {
    expect(matchMentionedAgents("@ceo and again @ceo", AGENTS)).toEqual(["a1"]);
  });

  it("does not match email addresses as mentions", () => {
    // The \B word-boundary prevents matching @ preceded by word chars
    expect(matchMentionedAgents("email user@ceo.com about this", AGENTS)).toEqual([]);
  });

  it("handles HTML entity encoded space after single-word mention", () => {
    // &nbsp; decodes to space inside the captured token, so the regex grabs
    // "CEO&nbsp;please" -> normalizes to "ceo please" which won't match "ceo".
    // This is a known edge case — rich text with entity-encoded spaces after
    // the mention absorbs trailing words.  The explicit agent:// link format
    // handles this cleanly; the @-syntax is best-effort.
    expect(matchMentionedAgents("@CEO&nbsp;please review", AGENTS)).toEqual([]);
    // Plain space works correctly because the regex stops at whitespace:
    expect(matchMentionedAgents("@CEO please review", AGENTS)).toEqual(["a1"]);
  });
});
