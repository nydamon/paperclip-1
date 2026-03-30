function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function truncateTail(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

/**
 * Cap resultJson before persisting to the database.
 *
 * Adapters often store full stdout/stderr (up to 4 MB each) in resultJson.
 * These large strings land in V8's large_object_space (objects >256 KB) and
 * are the primary driver of the OOM crash loop.  Full output is already
 * persisted separately in the NDJSON run-log files and in stdoutExcerpt /
 * stderrExcerpt columns, so keeping 8 KB tails here is sufficient for
 * quick diagnosis.
 */
const MAX_STORED_TEXT_BYTES = 8192;

export function capResultJsonForStorage(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resultJson)) {
    if (typeof value === "string" && value.length > MAX_STORED_TEXT_BYTES) {
      capped[key] = truncateTail(value, MAX_STORED_TEXT_BYTES);
    } else {
      capped[key] = value;
    }
  }
  return capped;
}
