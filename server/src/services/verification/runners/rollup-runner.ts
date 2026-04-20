import { eq, and, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Db } from "@paperclipai/db";
import { issues, issueWorkProducts, issueComments } from "@paperclipai/db";

/**
 * Roll-up consolidation runner (Phase 6b).
 *
 * Verifies that a "roll-up" task's comment body actually links to every declared child issue's
 * work products. Exists because DLD-3047 was created as "DLD-2796 Roll-up Bundle: consolidated
 * trial outputs and artifact index" but its comments drifted into axios security fix work
 * instead — the title said one thing, the comments did another.
 *
 * Spec format (JSON):
 *   {
 *     "rollupOfIssueIdentifiers": ["DLD-2801", "DLD-2802", "DLD-2803", "DLD-2805", "DLD-2806"],
 *     "requireWorkProductReferences": true,
 *     "requireIdentifierMentions": true
 *   }
 *
 * The runner:
 *   1. Loads the current issue (the roll-up task itself) — passed via `issueId`
 *   2. Looks up each identifier in `rollupOfIssueIdentifiers`
 *   3. For each child, pulls the latest comment body on the roll-up task
 *   4. Asserts the final comment mentions the child's identifier (e.g. "DLD-2801")
 *   5. If `requireWorkProductReferences` is true, asserts the final comment contains a string
 *      matching at least one of the child's work product URLs
 *
 * Returns passed / failed / unavailable like other runners.
 */

export interface RunRollupSpecInput {
  issueId: string;
  specPath: string;
  db: Db;
  skillsRoot?: string;
  readFileImpl?: typeof readFile;
}

export type RunRollupSpecResult =
  | {
      status: "passed";
      durationMs: number;
      declaredChildren: number;
      verifiedChildren: number;
    }
  | {
      status: "failed";
      durationMs: number;
      failureSummary: string;
    }
  | { status: "unavailable"; unavailableReason: string };

interface RollupSpec {
  rollupOfIssueIdentifiers: string[];
  requireWorkProductReferences?: boolean;
  requireIdentifierMentions?: boolean;
}

function validateSpec(parsed: unknown): { ok: true; spec: RollupSpec } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "spec not an object" };
  const s = parsed as Record<string, unknown>;
  if (
    !Array.isArray(s.rollupOfIssueIdentifiers) ||
    s.rollupOfIssueIdentifiers.length === 0 ||
    !s.rollupOfIssueIdentifiers.every(
      (id) => typeof id === "string" && /^[A-Z]+-\d+$/.test(id),
    )
  ) {
    return {
      ok: false,
      reason:
        "spec.rollupOfIssueIdentifiers must be a non-empty array of issue identifiers (e.g. DLD-1234)",
    };
  }
  if (
    s.requireWorkProductReferences !== undefined &&
    typeof s.requireWorkProductReferences !== "boolean"
  ) {
    return { ok: false, reason: "spec.requireWorkProductReferences must be boolean if present" };
  }
  if (
    s.requireIdentifierMentions !== undefined &&
    typeof s.requireIdentifierMentions !== "boolean"
  ) {
    return { ok: false, reason: "spec.requireIdentifierMentions must be boolean if present" };
  }
  return { ok: true, spec: parsed as RollupSpec };
}

export async function runRollupSpec(input: RunRollupSpecInput): Promise<RunRollupSpecResult> {
  const { specPath, db, skillsRoot = "/app", readFileImpl = readFile } = input;

  if (
    !/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.rollup\.spec\.(json|yaml|yml)$/.test(
      specPath,
    )
  ) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format for rollup runner: ${specPath}`,
    };
  }

  const absPath = resolve(join(skillsRoot, specPath));
  let raw: string;
  try {
    raw = await readFileImpl(absPath, "utf8");
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `spec is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const check = validateSpec(parsed);
  if (!check.ok) return { status: "unavailable", unavailableReason: check.reason };
  const spec = check.spec;
  const requireIdentifiers = spec.requireIdentifierMentions ?? true;
  const requireWorkProducts = spec.requireWorkProductReferences ?? true;

  const started = Date.now();

  // Load child issues by identifier (we need their IDs to look up work products)
  const childIssueRows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
    .from(issues)
    .where(inArray(issues.identifier, spec.rollupOfIssueIdentifiers));

  if (childIssueRows.length === 0) {
    return {
      status: "failed",
      durationMs: Math.floor(Date.now() - started),
      failureSummary: `none of the declared children [${spec.rollupOfIssueIdentifiers.join(", ")}] exist in the database`,
    };
  }

  const missingChildren = spec.rollupOfIssueIdentifiers.filter(
    (id) => !childIssueRows.some((row) => row.identifier === id),
  );
  if (missingChildren.length > 0) {
    return {
      status: "failed",
      durationMs: Math.floor(Date.now() - started),
      failureSummary: `declared children not found in database: ${missingChildren.join(", ")}`,
    };
  }

  // Load the concatenated body of all comments on the roll-up task.
  const commentRows = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(eq(issueComments.issueId, input.issueId));
  const fullCommentBody = commentRows.map((c) => c.body).join("\n\n");

  // For each child, assert (a) identifier mention and (b) work-product URL mention.
  const childIds = childIssueRows.map((r) => r.id);
  const allWorkProducts = await db
    .select({
      issueId: issueWorkProducts.issueId,
      type: issueWorkProducts.type,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
    })
    .from(issueWorkProducts)
    .where(inArray(issueWorkProducts.issueId, childIds));

  const workProductsByChild = new Map<string, Array<{ url: string | null; externalId: string | null }>>();
  for (const wp of allWorkProducts) {
    if (!workProductsByChild.has(wp.issueId)) workProductsByChild.set(wp.issueId, []);
    workProductsByChild.get(wp.issueId)!.push({ url: wp.url, externalId: wp.externalId });
  }

  let verified = 0;
  const failures: string[] = [];

  for (const child of childIssueRows) {
    const childFailures: string[] = [];

    if (requireIdentifiers) {
      if (!child.identifier || !fullCommentBody.includes(child.identifier)) {
        childFailures.push(`identifier ${child.identifier} not mentioned in roll-up comments`);
      }
    }

    if (requireWorkProducts) {
      const wps = workProductsByChild.get(child.id) ?? [];
      // Skip work-product check for cancelled children — they legitimately have no output.
      if (child.status === "cancelled") {
        // pass through — identifier mention is enough
      } else if (wps.length === 0) {
        childFailures.push(
          `child ${child.identifier} has no work products to reference (the child itself may be status-laundered)`,
        );
      } else {
        const anyReferenced = wps.some((wp) => {
          if (wp.url && fullCommentBody.includes(wp.url)) return true;
          if (wp.externalId && fullCommentBody.includes(wp.externalId)) return true;
          return false;
        });
        if (!anyReferenced) {
          childFailures.push(
            `child ${child.identifier} has work products but none are referenced in roll-up comments`,
          );
        }
      }
    }

    if (childFailures.length === 0) {
      verified += 1;
    } else {
      failures.push(...childFailures);
    }
  }

  if (failures.length > 0) {
    return {
      status: "failed",
      durationMs: Math.floor(Date.now() - started),
      failureSummary: `rollup verification failed (${verified}/${childIssueRows.length} children verified). Issues: ${failures.slice(0, 5).join("; ")}`,
    };
  }

  return {
    status: "passed",
    durationMs: Math.floor(Date.now() - started),
    declaredChildren: spec.rollupOfIssueIdentifiers.length,
    verifiedChildren: verified,
  };
}
