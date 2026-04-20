import { eq, and, gte, sql as drizzleSql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issueAttachments, issueComments, issueDocuments } from "@paperclipai/db";

/**
 * `terminal_status_requires_output` gate (Phase 6b).
 *
 * Fires when an agent transitions a code issue (executionWorkspaceId set) to `done`.
 * Checks that the issue produced SOMETHING — one of:
 *   1. issue_work_products row (branch/commit/PR)
 *   2. issue_attachments row (image/file)
 *   3. issue_documents row (writeup)
 *   4. a substantive final comment from a real actor (≥200 chars,
 *      not matching trivial-closing patterns like "QA: PASS" or "done")
 *
 * If none of the above, the gate blocks `done` with a message directing the agent to either
 * transition to `cancelled` (if the work won't happen) or produce actual output first.
 *
 * Motivation: audit of DLD Ent. 2026-03-14 to 2026-04-13 found 182 closed tasks with
 * executionWorkspaceId set and ZERO work products. The DLD-2805 pattern: agents closing issues
 * as `done` with comments like "Execution result: None — credential gate blocks all code
 * execution" and QA: PASS stamped. These should be `cancelled`, not `done`.
 *
 * Board users bypass (the existing pattern — only `req.actor.type === "agent"` is gated).
 */

export interface TerminalOutputGateInput {
  issueId: string;
  targetStatus: string;
  fromStatus: string;
  executionWorkspaceId: string | null;
  actorType: "agent" | "user" | "system" | "none" | "board";
}

export interface TerminalOutputGateResult {
  blocked: boolean;
  gate?: string;
  reason?: string;
  debug?: {
    workProductCount: number;
    attachmentCount: number;
    documentCount: number;
    substantiveCommentCount: number;
  };
}

/**
 * Patterns that indicate trivially-closing phrases. A comment is NOT substantive if, after
 * stripping all trivial phrases and whitespace, <200 printable chars remain. This catches
 * both short "QA: PASS" comments and long comments that are just the same phrase repeated
 * (e.g. "QA: PASS".repeat(30)).
 */
const TRIVIAL_PHRASE_PATTERNS: readonly RegExp[] = [
  /\bqa[\s:]+pass(ed)?\b/gi,
  /\bdone\b/gi,
  /\bclosed\b/gi,
  /\bclosing\b/gi,
  /\bresolved\b/gi,
  /\blgtm\b/gi,
  /(^|\s)\+1(\s|$)/g,
];

const MIN_SUBSTANTIVE_COMMENT_LENGTH = 200;

/**
 * Patterns that indicate a comment references a concrete deliverable:
 *   - http(s) URL
 *   - git SHA (7-40 lowercase hex — avoids matching random hex strings)
 *   - file path (contains /, starts with word char, ends in .ext)
 *   - GitHub PR reference (#123)
 *
 * A comment is only counted as "output" if it passes the length + trivial-phrase checks
 * AND contains at least one of these deliverable references. This closes the DLD-2805
 * loophole where long explanatory comments about WHY work didn't happen were treated
 * as output.
 */
const DELIVERABLE_REFERENCE_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s"'<>)\]]+/i,
  /\b[a-f0-9]{7,40}\b/,
  /(^|[\s(])\/[\w.-]+\/[\w./-]+\.\w{1,6}(\s|$|[)])/, // /path/to/file.ext
  /\b[\w-]+\.(ts|tsx|js|jsx|sql|md|json|yaml|yml|sh|py|rs|go|java)\b/, // bare filename.ext
  /\s#\d+\b/, // PR #123
];

function commentHasDeliverableReference(body: string): boolean {
  for (const pattern of DELIVERABLE_REFERENCE_PATTERNS) {
    if (pattern.test(body)) return true;
  }
  return false;
}

function isSubstantiveComment(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length < MIN_SUBSTANTIVE_COMMENT_LENGTH) return false;
  // Strip trivial phrases.
  let stripped = trimmed;
  for (const pattern of TRIVIAL_PHRASE_PATTERNS) {
    stripped = stripped.replace(pattern, " ");
  }
  const alphanumericRemaining = stripped.replace(/[^a-zA-Z0-9]/g, "");
  if (alphanumericRemaining.length < MIN_SUBSTANTIVE_COMMENT_LENGTH) return false;
  // Key change (Phase 6b.1): a long explanatory comment is NOT output unless it references
  // a concrete deliverable (URL, file path, SHA, PR number). DLD-2805 had 38 comments averaging
  // 345 chars — all long, none referencing deliverables. Those should not count.
  return commentHasDeliverableReference(body);
}

export async function evalTerminalOutputGate(
  db: Db,
  input: TerminalOutputGateInput,
): Promise<TerminalOutputGateResult> {
  // Only fires on done transitions from agents on code issues
  if (input.actorType !== "agent") return { blocked: false };
  if (input.targetStatus !== "done") return { blocked: false };
  if (input.fromStatus === "done") return { blocked: false };
  if (!input.executionWorkspaceId) return { blocked: false };

  // Count the four output categories in parallel
  const [workProductRows, attachmentRows, documentRows, commentRows] = await Promise.all([
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, input.issueId))
      .then((rows) => rows[0]?.count ?? 0),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, input.issueId))
      .then((rows) => rows[0]?.count ?? 0),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(issueDocuments)
      .where(eq(issueDocuments.issueId, input.issueId))
      .then((rows) => rows[0]?.count ?? 0),
    db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, input.issueId))
      .then((rows) =>
        rows.reduce((acc, row) => (isSubstantiveComment(row.body) ? acc + 1 : acc), 0),
      ),
  ]);

  const hasAnyOutput =
    workProductRows > 0 || attachmentRows > 0 || documentRows > 0 || commentRows > 0;

  if (hasAnyOutput) {
    return {
      blocked: false,
      debug: {
        workProductCount: workProductRows,
        attachmentCount: attachmentRows,
        documentCount: documentRows,
        substantiveCommentCount: commentRows,
      },
    };
  }

  return {
    blocked: true,
    gate: "terminal_status_requires_output",
    reason:
      "Cannot mark a code issue `done` without at least one output: a work product (branch/commit/PR), an attachment (screenshot/file), a linked document, or a substantive comment (≥200 chars, not 'QA: PASS' or similar closing-only phrase). If the work won't happen, transition to `cancelled` instead. This gate exists because the 2026-04 DLD Ent. audit found 182 closed tasks with zero output — status-laundering should be eliminated.",
    debug: {
      workProductCount: workProductRows,
      attachmentCount: attachmentRows,
      documentCount: documentRows,
      substantiveCommentCount: commentRows,
    },
  };
}
