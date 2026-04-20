import { and, eq, gte, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { verificationChaosRuns } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { createVerificationWorker } from "./verification-worker.js";
import { logger } from "../../middleware/logger.js";

/**
 * Verification system self-test ("chaos test").
 *
 * Every day, the sweeper runs a known-failing verification against a synthetic target and
 * asserts the system catches it. If the test returns anything other than `failed`, the
 * verification system is compromised (false pass) and an immediate board alert fires.
 *
 * The chaos scenario runs an API spec that asks the worker to GET a URL that always returns
 * 404. The spec expects 200. The worker should return `failed`. If it returns `passed`, that
 * means the runner is silently succeeding on non-2xx responses — a critical system bug.
 *
 * The test records its result in `verification_chaos_runs` regardless of outcome. The sweeper
 * checks the most recent run per 24h window; if nothing has run in the last 25h, something has
 * gone wrong with the cron itself and an alert fires.
 */

const CHAOS_SCENARIO_API = "api_always_fails";
const CHAOS_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHAOS_ALERT_WINDOW_MS = 25 * 60 * 60 * 1000;

export interface ChaosRunResult {
  scenario: string;
  expectedOutcome: "failed";
  actualOutcome: string;
  passed: boolean;
}

/**
 * Runs the chaos scenario against a synthetic failing endpoint. Returns the result but does
 * NOT persist it — the caller wraps the result with persistence + alerting.
 */
async function runApiChaosScenario(db: Db, storage: StorageService): Promise<ChaosRunResult> {
  // Write the spec to a temporary location the worker can read. We use a well-known path under
  // /tmp/chaos which is always writable in the server container.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const chaosDir = "/app/skills/acceptance-api-specs/tests";
  await mkdir(chaosDir, { recursive: true });
  const specRelPath = "skills/acceptance-api-specs/tests/__CHAOS_always_fails.api.spec.json";
  const absPath = `/app/${specRelPath.replace(/^\//, "")}`;
  const spec = {
    method: "GET",
    url: "https://httpstat.us/404",
    expectedStatus: 200,
  };
  await writeFile(absPath, JSON.stringify(spec, null, 2), "utf8");

  // Use a synthetic issue id for the chaos run (does not need a real issue row because the
  // worker dispatches by deliverableType; recordAttempt WILL try to insert a verification_runs
  // row referencing this issue_id though, so we need a real issue to point at or we short-circuit).
  //
  // Simplest: skip persistence entirely by running the runner directly, bypassing the worker's
  // retry-budget + row-insertion wrapper. The chaos test doesn't need retries; one attempt is enough.
  const { runApiSpec } = await import("./runners/api-runner.js");
  const result = await runApiSpec({
    issueId: "chaos-synthetic",
    specPath: specRelPath,
  });

  return {
    scenario: CHAOS_SCENARIO_API,
    expectedOutcome: "failed",
    actualOutcome: result.status,
    passed: result.status === "failed",
  };
}

export interface ChaosSweeperOutput {
  ran: boolean;
  scenario?: string;
  passed?: boolean;
  staleAlert?: boolean;
  error?: string;
}

/**
 * Called from the scheduler. Runs the chaos scenario at most once per 24h, records the result,
 * and emits alerts on (a) failed chaos test (system compromised) or (b) stale chaos runs (cron
 * itself is broken).
 */
export async function runChaosSweeper(
  db: Db,
  storage: StorageService,
): Promise<ChaosSweeperOutput> {
  try {
    // Check if we've run in the last 24h
    const recent = await db
      .select()
      .from(verificationChaosRuns)
      .where(
        and(
          eq(verificationChaosRuns.scenario, CHAOS_SCENARIO_API),
          gte(verificationChaosRuns.runAt, new Date(Date.now() - CHAOS_WINDOW_MS)),
        ),
      )
      .orderBy(desc(verificationChaosRuns.runAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (recent) {
      // Nothing to do. Already ran today.
      return { ran: false };
    }

    // Check for stale — no run in the last 25h means the cron itself is broken
    const lastEver = await db
      .select()
      .from(verificationChaosRuns)
      .where(eq(verificationChaosRuns.scenario, CHAOS_SCENARIO_API))
      .orderBy(desc(verificationChaosRuns.runAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const staleAlert =
      !!lastEver && Date.now() - new Date(lastEver.runAt).getTime() > CHAOS_ALERT_WINDOW_MS;

    const result = await runApiChaosScenario(db, storage);
    await db.insert(verificationChaosRuns).values({
      scenario: result.scenario,
      expectedOutcome: result.expectedOutcome,
      actualOutcome: result.actualOutcome,
      passed: result.passed,
    });

    if (!result.passed) {
      logger.error(
        { scenario: result.scenario, actualOutcome: result.actualOutcome },
        "🚨 VERIFICATION CHAOS TEST FAILED — the verification system is returning false passes. This is a board-level incident.",
      );
    } else {
      logger.info(
        { scenario: result.scenario, actualOutcome: result.actualOutcome },
        "verification chaos test passed (system correctly caught the synthetic failure)",
      );
    }

    if (staleAlert) {
      logger.error(
        { lastRunAt: lastEver?.runAt },
        "⚠️ Verification chaos test was stale — last run was more than 25h ago. Cron is broken.",
      );
    }

    return {
      ran: true,
      scenario: result.scenario,
      passed: result.passed,
      staleAlert,
    };
  } catch (err) {
    logger.error({ err }, "chaos sweeper error");
    return { ran: false, error: err instanceof Error ? err.message : String(err) };
  }
}

