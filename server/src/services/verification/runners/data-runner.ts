/**
 * Data deliverable runner.
 *
 * Verifies one-shot DB data operations (backfills, seed scripts, corrections) by:
 *   1. Running `preAssertSql` against a throwaway schema pre-populated with `fixtureSql`
 *   2. Running `operationSql` (the data operation under test)
 *   3. Running `postAssertSql` — expects specific rows to exist OR to have changed
 *   4. Optionally running `operationSql` a SECOND time to verify idempotency (postAssert must
 *      still hold after the repeat)
 *
 * The runner uses the same throwaway schema technique as migration-runner but adds fixture
 * data + assertion rows.
 *
 * Spec format (JSON):
 *   {
 *     "fixtureSql": "CREATE TABLE SCHEMA.users (id serial PRIMARY KEY, email text, status text); INSERT INTO SCHEMA.users (email, status) VALUES ('a@test.com', 'active'), ('b@test.com', 'inactive');",
 *     "preAssertSql": "SELECT count(*) FROM SCHEMA.users WHERE status = 'active';",
 *     "preAssertExpected": 1,
 *     "operationSql": "UPDATE SCHEMA.users SET status = 'active' WHERE status = 'inactive';",
 *     "postAssertSql": "SELECT count(*) FROM SCHEMA.users WHERE status = 'active';",
 *     "postAssertExpected": 2,
 *     "idempotent": true
 *   }
 *
 * All SQL must use the SCHEMA placeholder. Same denylist as migration-runner.
 */

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export interface RunDataSpecInput {
  issueId: string;
  specPath: string;
  db: Db;
  skillsRoot?: string;
  readFileImpl?: typeof readFile;
}

export type RunDataSpecResult =
  | { status: "passed"; durationMs: number; assertionsChecked: number }
  | { status: "failed"; durationMs: number; failureSummary: string }
  | { status: "unavailable"; unavailableReason: string };

interface DataSpec {
  fixtureSql: string;
  preAssertSql?: string;
  preAssertExpected?: number;
  operationSql: string;
  postAssertSql: string;
  postAssertExpected: number;
  idempotent?: boolean;
}

function validateSpec(parsed: unknown): { ok: true; spec: DataSpec } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "spec not an object" };
  const s = parsed as Record<string, unknown>;
  if (typeof s.fixtureSql !== "string" || !s.fixtureSql.includes("SCHEMA")) {
    return { ok: false, reason: "spec.fixtureSql must be a string containing SCHEMA placeholder" };
  }
  if (typeof s.operationSql !== "string" || !s.operationSql.includes("SCHEMA")) {
    return { ok: false, reason: "spec.operationSql must be a string containing SCHEMA placeholder" };
  }
  if (typeof s.postAssertSql !== "string" || !s.postAssertSql.includes("SCHEMA")) {
    return { ok: false, reason: "spec.postAssertSql must be a string containing SCHEMA placeholder" };
  }
  if (typeof s.postAssertExpected !== "number") {
    return { ok: false, reason: "spec.postAssertExpected must be a number" };
  }
  if (s.preAssertSql !== undefined && typeof s.preAssertSql !== "string") {
    return { ok: false, reason: "spec.preAssertSql must be a string if present" };
  }
  if (s.preAssertExpected !== undefined && typeof s.preAssertExpected !== "number") {
    return { ok: false, reason: "spec.preAssertExpected must be a number if present" };
  }
  return { ok: true, spec: parsed as DataSpec };
}

const FORBIDDEN_PATTERNS = [
  /DROP\s+SCHEMA/i,
  /DROP\s+DATABASE/i,
  /TRUNCATE\s+TABLE\s+(?!SCHEMA\.)/i,
  /DELETE\s+FROM\s+(?!SCHEMA\.)/i,
  /UPDATE\s+(?!SCHEMA\.)/i,
];

function guard(sqlText: string): { ok: true } | { ok: false; reason: string } {
  for (const f of FORBIDDEN_PATTERNS) {
    if (f.test(sqlText)) {
      return { ok: false, reason: `sql contains forbidden pattern: ${f.source}` };
    }
  }
  return { ok: true };
}

function extractCount(rows: unknown): number {
  // drizzle execute() returns different shapes depending on the driver; we accept both
  // postgres-js style `{rows: [...]}` and pg style `{rows: [{count: n}]}`.
  const asAny = rows as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const rowList = Array.isArray(asAny) ? asAny : asAny.rows ?? [];
  if (rowList.length === 0) return 0;
  const first = rowList[0];
  // Find the first numeric value in the row
  for (const value of Object.values(first)) {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return parseInt(value, 10);
  }
  return 0;
}

export async function runDataSpec(input: RunDataSpecInput): Promise<RunDataSpecResult> {
  const { specPath, db, skillsRoot = "/app", readFileImpl = readFile } = input;

  if (
    !/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.data\.spec\.(json|yaml|yml)$/.test(specPath)
  ) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format for data runner: ${specPath}`,
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

  for (const block of [spec.fixtureSql, spec.operationSql, spec.postAssertSql, spec.preAssertSql]) {
    if (block !== undefined) {
      const g = guard(block);
      if (!g.ok) return { status: "unavailable", unavailableReason: g.reason };
    }
  }

  const schemaName = `verif_data_${input.issueId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 16)}_${Date.now()}`;

  const started = Date.now();
  let assertionsChecked = 0;

  const cleanup = async () => {
    try {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`));
    } catch {
      // best effort
    }
  };

  try {
    await db.execute(sql.raw(`CREATE SCHEMA ${schemaName};`));
    // Also set search_path so relative references work; but specs must still use SCHEMA. prefix.
    await db.execute(sql.raw(spec.fixtureSql.replace(/\bSCHEMA\b/g, schemaName)));

    if (spec.preAssertSql !== undefined && spec.preAssertExpected !== undefined) {
      const preRows = await db.execute(sql.raw(spec.preAssertSql.replace(/\bSCHEMA\b/g, schemaName)));
      const count = extractCount(preRows);
      if (count !== spec.preAssertExpected) {
        await cleanup();
        return {
          status: "failed",
          durationMs: Math.floor(Date.now() - started),
          failureSummary: `preAssert expected ${spec.preAssertExpected}, got ${count} (fixture setup may be wrong)`,
        };
      }
      assertionsChecked += 1;
    }

    await db.execute(sql.raw(spec.operationSql.replace(/\bSCHEMA\b/g, schemaName)));

    const postRows = await db.execute(sql.raw(spec.postAssertSql.replace(/\bSCHEMA\b/g, schemaName)));
    const count = extractCount(postRows);
    if (count !== spec.postAssertExpected) {
      await cleanup();
      return {
        status: "failed",
        durationMs: Math.floor(Date.now() - started),
        failureSummary: `postAssert expected ${spec.postAssertExpected}, got ${count}`,
      };
    }
    assertionsChecked += 1;

    if (spec.idempotent) {
      await db.execute(sql.raw(spec.operationSql.replace(/\bSCHEMA\b/g, schemaName)));
      const idempRows = await db.execute(
        sql.raw(spec.postAssertSql.replace(/\bSCHEMA\b/g, schemaName)),
      );
      const idempCount = extractCount(idempRows);
      if (idempCount !== spec.postAssertExpected) {
        await cleanup();
        return {
          status: "failed",
          durationMs: Math.floor(Date.now() - started),
          failureSummary: `idempotency check failed: after second run, postAssert got ${idempCount} (expected ${spec.postAssertExpected})`,
        };
      }
      assertionsChecked += 1;
    }

    await cleanup();
    return {
      status: "passed",
      durationMs: Math.floor(Date.now() - started),
      assertionsChecked,
    };
  } catch (err) {
    await cleanup();
    return {
      status: "failed",
      durationMs: Math.floor(Date.now() - started),
      failureSummary: `runner error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
