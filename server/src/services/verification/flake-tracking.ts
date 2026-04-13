import { eq, sql as drizzleSql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { specMetadata } from "@paperclipai/db";

/**
 * Flake tracking (Phase 6).
 *
 * On every definitive verification run (passed or failed, not unavailable), we update
 * `spec_metadata` counters for the spec path. When a spec transitions from `failed` → `passed`
 * within a 7-day window, we increment flake_count.
 *
 * A spec with `flake_count >= 2 in 7 days` is marked `flaky = true`. Flaky specs get more
 * retries and their escalations include a flake-history note so reviewers know to investigate
 * the spec itself rather than the code.
 *
 * The data here is used by the dashboard (Phase 4b+) to surface chronically flaky specs so
 * the QA agents can fix them, and by the escalation comments for context.
 */

export interface UpdateSpecMetadataInput {
  specPath: string;
  finalStatus: "passed" | "failed" | "overridden";
  /** Was the previous attempt for this spec a failure? Used to detect fail→pass transitions. */
  previousAttemptFailed: boolean;
}

const FLAKE_THRESHOLD_COUNT = 2;
const FLAKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function updateSpecMetadata(db: Db, input: UpdateSpecMetadataInput): Promise<void> {
  const now = new Date();

  // Ensure a row exists using ON CONFLICT DO NOTHING
  await db
    .insert(specMetadata)
    .values({
      specPath: input.specPath,
      totalRuns: 0,
      passCount: 0,
      failCount: 0,
      flakeCount: 0,
      flaky: false,
    })
    .onConflictDoNothing();

  // Compute the delta in a single UPDATE
  const isPass = input.finalStatus === "passed" || input.finalStatus === "overridden";
  const isFail = input.finalStatus === "failed";
  const isFlake = isPass && input.previousAttemptFailed;

  await db
    .update(specMetadata)
    .set({
      totalRuns: drizzleSql`${specMetadata.totalRuns} + 1`,
      passCount: isPass ? drizzleSql`${specMetadata.passCount} + 1` : specMetadata.passCount,
      failCount: isFail ? drizzleSql`${specMetadata.failCount} + 1` : specMetadata.failCount,
      flakeCount: isFlake ? drizzleSql`${specMetadata.flakeCount} + 1` : specMetadata.flakeCount,
      lastRunAt: now,
      lastFlakeAt: isFlake ? now : specMetadata.lastFlakeAt,
    })
    .where(eq(specMetadata.specPath, input.specPath));

  // Re-evaluate flaky flag. A spec is flaky if flake_count >= threshold AND the most recent flake
  // was within the window. We need a round-trip to read the current counts.
  const row = await db
    .select({
      flakeCount: specMetadata.flakeCount,
      lastFlakeAt: specMetadata.lastFlakeAt,
      flaky: specMetadata.flaky,
    })
    .from(specMetadata)
    .where(eq(specMetadata.specPath, input.specPath))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) return;

  const flakyNow =
    row.flakeCount >= FLAKE_THRESHOLD_COUNT &&
    row.lastFlakeAt !== null &&
    now.getTime() - new Date(row.lastFlakeAt).getTime() < FLAKE_WINDOW_MS;

  if (flakyNow !== row.flaky) {
    await db
      .update(specMetadata)
      .set({ flaky: flakyNow })
      .where(eq(specMetadata.specPath, input.specPath));
  }
}

/**
 * Load flake stats for a spec — used by escalation comments so we can note if a spec has been
 * flaking recently.
 */
export async function getSpecFlakeStats(db: Db, specPath: string) {
  return db
    .select()
    .from(specMetadata)
    .where(eq(specMetadata.specPath, specPath))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
