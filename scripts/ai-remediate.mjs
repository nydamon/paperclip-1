#!/usr/bin/env node

/**
 * AI Code Remediation Script
 *
 * Takes AI review findings + file contents, sends them to an LLM, and outputs
 * file patches. Designed to work alongside ai-review.mjs — the reviewer judges,
 * the remediator fixes.
 *
 * Pure-function exports for testability. CLI entry point at bottom.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenRouter } from "./ai-review.mjs";

const MAX_FILE_BYTES = 50_000;
const MAX_AFFECTED_FILES = 5;

const REMEDIATION_SYSTEM_PROMPT = `You are a senior engineer tasked with fixing code review findings.

You receive:
1. A list of findings (severity, message, file, line)
2. The current contents of affected files
3. The original PR diff for context

Your job:
- Fix ONLY the issues described in the findings
- Do NOT refactor, optimize, or "improve" unrelated code
- Preserve existing code style (indentation, naming, patterns)
- NEVER modify CI/CD workflow files (.github/workflows/*)
- If a finding cannot be fixed (e.g. requires architectural change), skip it and explain why

## Output format

Respond with ONLY a JSON object (no markdown fences):

{
  "patches": [
    {
      "file": "path/to/file.ts",
      "content": "...full file content after fix..."
    }
  ],
  "explanation": "Brief summary of what was fixed",
  "skipped": [
    {
      "file": "path/to/file.ts",
      "reason": "Why this finding was skipped"
    }
  ]
}

Rules:
- "content" must be the COMPLETE file content (not a diff)
- Only include files that actually changed
- If no fixes are possible, return empty patches array
- Keep explanations concise`;

/**
 * Extract unique file paths from review findings.
 */
export function collectAffectedFiles(findings) {
  if (!Array.isArray(findings)) return [];
  const files = new Set();
  for (const f of findings) {
    if (f.file && typeof f.file === "string" && f.file.trim()) {
      files.add(f.file.trim());
    }
  }
  return [...files];
}

/**
 * Check if any findings are critical severity.
 */
export function hasCriticalFindings(findings) {
  if (!Array.isArray(findings)) return false;
  return findings.some((f) => f.severity === "critical");
}

/**
 * Build the LLM prompt for remediation.
 */
export function buildRemediationPrompt({ findings, fileContents, diff }) {
  const parts = [
    "## Findings to fix\n",
    "```json",
    JSON.stringify(findings, null, 2),
    "```\n",
  ];

  if (fileContents && Object.keys(fileContents).length > 0) {
    parts.push("## Current file contents\n");
    for (const [filePath, content] of Object.entries(fileContents)) {
      const ext = filePath.split(".").pop() || "txt";
      parts.push(`### ${filePath}\n`, "```" + ext, content, "```\n");
    }
  }

  if (diff) {
    parts.push("## Original PR diff (for context)\n", "```diff", diff, "```");
  }

  return parts.join("\n");
}

/**
 * Parse the LLM remediation response into structured patches.
 */
export function parseRemediationResponse(raw) {
  if (!raw) return { patches: [], explanation: "", skipped: [] };

  let text = raw.trim();
  // Strip markdown code fences if present
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(text);
    return {
      patches: Array.isArray(parsed.patches) ? parsed.patches.filter(
        (p) => p.file && typeof p.file === "string" && typeof p.content === "string"
      ) : [],
      explanation: String(parsed.explanation || ""),
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    };
  } catch {
    return { patches: [], explanation: "Failed to parse remediation response", skipped: [] };
  }
}

/**
 * Filter out patches targeting workflow files or files that weren't in the input.
 */
export function sanitizePatches(patches, knownFiles) {
  const known = new Set(knownFiles);
  return patches.filter((p) => {
    // Block workflow file modifications
    if (p.file.startsWith(".github/workflows/")) return false;
    // Only allow patching files we provided
    if (!known.has(p.file)) return false;
    return true;
  });
}

/**
 * Main remediation orchestrator.
 * Returns { patches, explanation, skipped, error? }.
 */
export async function runRemediation({ apiKey, findings, fileContents, diff }) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const affectedFiles = collectAffectedFiles(findings);

  if (affectedFiles.length === 0) {
    return { patches: [], explanation: "No affected files found in findings", skipped: [] };
  }

  if (affectedFiles.length > MAX_AFFECTED_FILES) {
    return {
      patches: [],
      explanation: `Too many affected files (${affectedFiles.length} > ${MAX_AFFECTED_FILES}). Skipping remediation.`,
      skipped: affectedFiles.map((f) => ({ file: f, reason: "Too many files for automated remediation" })),
    };
  }

  if (hasCriticalFindings(findings)) {
    return {
      patches: [],
      explanation: "Critical findings present — skipping automated remediation",
      skipped: findings
        .filter((f) => f.severity === "critical")
        .map((f) => ({ file: f.file || "", reason: "Critical finding requires human review" })),
    };
  }

  const userPrompt = buildRemediationPrompt({ findings, fileContents, diff });

  const responseText = await callOpenRouter(apiKey, REMEDIATION_SYSTEM_PROMPT, userPrompt);
  const result = parseRemediationResponse(responseText);

  // Filter out hallucinated or forbidden patches
  result.patches = sanitizePatches(result.patches, Object.keys(fileContents || {}));

  return result;
}

/* ── CLI entry point ─────────────────────────────────────────────── */

async function main() {
  try {
    // Read inputs from environment (set by the workflow)
    const findings = JSON.parse(process.env.REMEDIATION_FINDINGS || "[]");
    const fileContents = JSON.parse(process.env.REMEDIATION_FILE_CONTENTS || "{}");
    const diff = process.env.REMEDIATION_DIFF || "";

    const result = await runRemediation({
      apiKey: process.env.OPENROUTER_API_KEY,
      findings,
      fileContents,
      diff,
    });

    console.log(JSON.stringify(result));
  } catch (err) {
    console.log(JSON.stringify({
      patches: [],
      explanation: `Remediation failed: ${err.message}`,
      skipped: [],
    }));
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) main();
