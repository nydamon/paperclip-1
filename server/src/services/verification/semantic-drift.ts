/**
 * Semantic drift check (Phase 6b) — log-only.
 *
 * Compares an issue's title+description against the concatenated body of its comments at close
 * time. If the overlap is too low, emits an `issue.semantic_drift_detected` activity log entry
 * so the board can spot cases where the task title says one thing and the actual work was
 * something else (e.g. DLD-3047 titled "Roll-up Bundle" with comments entirely about axios).
 *
 * This is an intentionally-dumb word-overlap heuristic, not an LLM call. Reasons:
 *   1. Gate path must be fast — no external API calls
 *   2. False positives are acceptable because it's log-only (no 422 blocking)
 *   3. An LLM-based version is a future Phase 7 addition, gated behind a separate flag
 *
 * Algorithm:
 *   - Tokenize title+description into a bag of lowercase words ≥ 4 chars, minus a stop list
 *   - Tokenize comment body into the same bag
 *   - Compute Jaccard similarity on the word sets
 *   - If Jaccard < threshold (default 0.15), emit drift warning
 *
 * Threshold is intentionally loose — we only want to catch EXTREME drift (DLD-3047 style),
 * not mild evolution. The audit found DLD-3047 had 36 axios-keyword comments; its Jaccard
 * with "DLD-2796 Roll-up Bundle: consolidated trial outputs" title is approximately 0.
 */

const STOP_WORDS = new Set<string>([
  "the", "and", "for", "with", "this", "that", "from", "into", "over", "under",
  "have", "been", "were", "will", "shall", "should", "would", "could", "might",
  "about", "after", "again", "against", "among", "around", "because", "before",
  "being", "below", "between", "both", "cannot", "does", "doing", "down", "during",
  "each", "either", "here", "into", "itself", "just", "more", "most", "only", "other",
  "some", "such", "than", "then", "there", "these", "they", "those", "through",
  "until", "upon", "very", "what", "when", "where", "which", "while", "will", "your",
  "issue", "task", "issues", "tasks", "agent", "agents", "comment", "comments",
  "status", "done", "pass", "passed", "review", "ready", "required", "requires",
  "please", "update", "updated", "check", "checked", "note", "notes",
]);

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return new Set(words);
}

export function computeJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

export interface SemanticDriftInput {
  title: string;
  description: string | null;
  commentBody: string;
  threshold?: number;
}

export interface SemanticDriftResult {
  drift: boolean;
  jaccard: number;
  threshold: number;
  titleTokenCount: number;
  commentTokenCount: number;
}

export function checkSemanticDrift(input: SemanticDriftInput): SemanticDriftResult {
  const threshold = input.threshold ?? 0.15;
  const titleBag = tokenize(`${input.title}\n${input.description ?? ""}`);
  const commentBag = tokenize(input.commentBody);

  // Skip when one side has too few tokens to be meaningful — avoid false positives on
  // short titles or empty comment sections. The comment threshold is deliberately low
  // (10 unique non-stopword tokens) because stop-word filtering is aggressive and real
  // comments shrink a lot after filtering.
  if (titleBag.size < 3 || commentBag.size < 10) {
    return {
      drift: false,
      jaccard: 1,
      threshold,
      titleTokenCount: titleBag.size,
      commentTokenCount: commentBag.size,
    };
  }

  const jaccard = computeJaccard(titleBag, commentBag);
  return {
    drift: jaccard < threshold,
    jaccard,
    threshold,
    titleTokenCount: titleBag.size,
    commentTokenCount: commentBag.size,
  };
}
