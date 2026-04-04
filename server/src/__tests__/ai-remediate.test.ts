import { describe, expect, it } from "vitest";

const {
  collectAffectedFiles,
  hasCriticalFindings,
  buildRemediationPrompt,
  parseRemediationResponse,
  sanitizePatches,
} = await import("../../../scripts/ai-remediate.mjs");

describe("ai-remediate", () => {
  describe("collectAffectedFiles", () => {
    it("extracts unique file paths from findings", () => {
      const findings = [
        { severity: "warning", message: "Missing error handling", file: "src/api.ts", line: 10 },
        { severity: "note", message: "Consider naming", file: "src/utils.ts", line: 5 },
        { severity: "warning", message: "Another issue", file: "src/api.ts", line: 20 },
      ];
      expect(collectAffectedFiles(findings)).toEqual(["src/api.ts", "src/utils.ts"]);
    });

    it("handles empty or missing findings", () => {
      expect(collectAffectedFiles([])).toEqual([]);
      expect(collectAffectedFiles(null)).toEqual([]);
      expect(collectAffectedFiles(undefined)).toEqual([]);
    });

    it("skips findings without file paths", () => {
      const findings = [
        { severity: "note", message: "General note", file: "", line: 0 },
        { severity: "warning", message: "Has file", file: "src/index.ts", line: 1 },
        { severity: "note", message: "No file prop" },
      ];
      expect(collectAffectedFiles(findings)).toEqual(["src/index.ts"]);
    });

    it("trims whitespace from file paths", () => {
      const findings = [
        { severity: "warning", message: "x", file: " src/foo.ts ", line: 1 },
      ];
      expect(collectAffectedFiles(findings)).toEqual(["src/foo.ts"]);
    });
  });

  describe("hasCriticalFindings", () => {
    it("returns true when critical findings exist", () => {
      expect(hasCriticalFindings([
        { severity: "critical", message: "SQL injection" },
      ])).toBe(true);
    });

    it("returns false for non-critical findings", () => {
      expect(hasCriticalFindings([
        { severity: "warning", message: "Missing tests" },
        { severity: "note", message: "Style suggestion" },
      ])).toBe(false);
    });

    it("returns false for empty or null input", () => {
      expect(hasCriticalFindings([])).toBe(false);
      expect(hasCriticalFindings(null)).toBe(false);
    });
  });

  describe("buildRemediationPrompt", () => {
    it("includes findings, file contents, and diff", () => {
      const prompt = buildRemediationPrompt({
        findings: [{ severity: "warning", message: "Missing error handling", file: "src/api.ts", line: 10 }],
        fileContents: { "src/api.ts": "const x = 1;" },
        diff: "--- a/src/api.ts\n+++ b/src/api.ts",
      });
      expect(prompt).toContain("Missing error handling");
      expect(prompt).toContain("const x = 1;");
      expect(prompt).toContain("--- a/src/api.ts");
      expect(prompt).toContain("## Findings to fix");
      expect(prompt).toContain("## Current file contents");
      expect(prompt).toContain("## Original PR diff");
    });

    it("omits file contents section when empty", () => {
      const prompt = buildRemediationPrompt({
        findings: [{ severity: "warning", message: "x" }],
        fileContents: {},
        diff: "diff",
      });
      expect(prompt).not.toContain("## Current file contents");
    });

    it("omits diff section when empty", () => {
      const prompt = buildRemediationPrompt({
        findings: [{ severity: "warning", message: "x" }],
        fileContents: { "a.ts": "code" },
        diff: "",
      });
      expect(prompt).not.toContain("## Original PR diff");
    });
  });

  describe("parseRemediationResponse", () => {
    it("parses valid JSON response", () => {
      const raw = JSON.stringify({
        patches: [{ file: "src/api.ts", content: "fixed code" }],
        explanation: "Fixed error handling",
        skipped: [],
      });
      const result = parseRemediationResponse(raw);
      expect(result.patches).toHaveLength(1);
      expect(result.patches[0].file).toBe("src/api.ts");
      expect(result.patches[0].content).toBe("fixed code");
      expect(result.explanation).toBe("Fixed error handling");
    });

    it("strips markdown code fences", () => {
      const raw = "```json\n" + JSON.stringify({
        patches: [{ file: "a.ts", content: "x" }],
        explanation: "done",
        skipped: [],
      }) + "\n```";
      const result = parseRemediationResponse(raw);
      expect(result.patches).toHaveLength(1);
    });

    it("returns empty patches for unparseable response", () => {
      const result = parseRemediationResponse("this is not json at all");
      expect(result.patches).toEqual([]);
      expect(result.explanation).toContain("Failed to parse");
    });

    it("returns empty patches for null/undefined", () => {
      expect(parseRemediationResponse(null).patches).toEqual([]);
      expect(parseRemediationResponse(undefined).patches).toEqual([]);
    });

    it("filters out patches missing file or content", () => {
      const raw = JSON.stringify({
        patches: [
          { file: "good.ts", content: "code" },
          { file: "", content: "no file" },
          { content: "missing file key" },
          { file: "no-content.ts" },
        ],
        explanation: "",
        skipped: [],
      });
      const result = parseRemediationResponse(raw);
      expect(result.patches).toHaveLength(1);
      expect(result.patches[0].file).toBe("good.ts");
    });

    it("handles missing optional fields gracefully", () => {
      const raw = JSON.stringify({ patches: [] });
      const result = parseRemediationResponse(raw);
      expect(result.explanation).toBe("");
      expect(result.skipped).toEqual([]);
    });
  });

  describe("sanitizePatches", () => {
    it("blocks workflow file patches", () => {
      const patches = [
        { file: ".github/workflows/ci.yml", content: "hacked" },
        { file: "src/api.ts", content: "legit fix" },
      ];
      const result = sanitizePatches(patches, ["src/api.ts", ".github/workflows/ci.yml"]);
      expect(result).toHaveLength(1);
      expect(result[0].file).toBe("src/api.ts");
    });

    it("blocks patches for unknown files", () => {
      const patches = [
        { file: "src/api.ts", content: "fix" },
        { file: "src/hallucinated.ts", content: "does not exist" },
      ];
      const result = sanitizePatches(patches, ["src/api.ts"]);
      expect(result).toHaveLength(1);
      expect(result[0].file).toBe("src/api.ts");
    });

    it("returns empty for all-blocked patches", () => {
      const patches = [
        { file: ".github/workflows/deploy.yml", content: "bad" },
      ];
      expect(sanitizePatches(patches, [".github/workflows/deploy.yml"])).toEqual([]);
    });
  });
});
