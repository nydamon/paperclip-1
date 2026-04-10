import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, asBoolean, parseObject } from "../utils.js";

/**
 * URL pattern matchers for Composio MCP endpoints.
 * Pattern A: /tool_router/{session}/mcp
 * Pattern B: /v3/mcp/{mcp_config_id}/mcp
 */
const MCP_TOOL_ROUTER_RE = /^\/tool_router\/([^/]+)\/mcp(?:\/.*)?$/;
const MCP_V3_RE = /^\/v3\/mcp\/([^/]+)\/mcp(?:\/.*)?$/;

const COMPOSIO_ACCEPT_DEFAULT = "application/json, text/event-stream";

function isComposioMcpPath(path: string): { pattern: "tool_router" | "v3"; sessionOrConfigId: string } | null {
  const toolRouterMatch = path.match(MCP_TOOL_ROUTER_RE);
  if (toolRouterMatch) {
    return { pattern: "tool_router", sessionOrConfigId: toolRouterMatch[1] };
  }
  const v3Match = path.match(MCP_V3_RE);
  if (v3Match) {
    return { pattern: "v3", sessionOrConfigId: v3Match[1] };
  }
  return null;
}

/**
 * Normalize user_id to prevent double-prefix drift.
 * Guard: if the userId already starts with the configured prefix,
 * do NOT prefix again. E.g., prefix="user-" and userId="user-123" → "user-123" (not "user-user-123")
 */
function normalizeUserId(userId: string, prefix: string | null): string {
  if (!userId || !prefix) return userId;
  if (userId.startsWith(prefix)) return userId;
  return `${prefix}${userId}`;
}

interface ComposioMcpConfig {
  baseUrl?: string;
  apiKey?: string;
  sessionId?: string;
  mcpConfigId?: string;
  userIdPrefix?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  acceptHeader?: string;
  /** Full path override — takes precedence over sessionId/mcpConfigId pattern matching */
  path?: string;
  /** Additional body fields to merge */
  extraBody?: Record<string, unknown>;
}

/**
 * Build the target URL based on config.
 * Priority: explicit path > sessionId pattern > mcpConfigId pattern
 */
function buildTargetUrl(
  baseUrl: string,
  path: string | null,
  sessionId: string | null,
  mcpConfigId: string | null,
): string {
  const base = baseUrl.replace(/\/$/, "");

  if (path) {
    return `${base}${path.startsWith("/") ? path : "/" + path}`;
  }

  if (sessionId) {
    return `${base}/tool_router/${sessionId}/mcp`;
  }

  if (mcpConfigId) {
    return `${base}/v3/mcp/${mcpConfigId}/mcp`;
  }

  throw new Error(
    "composio_mcp adapter: must provide either path, sessionId, or mcpConfigId",
  );
}

function structuredNon2xxLog(
  status: number,
  statusText: string,
  cfRay: string | null,
  body: string,
  url: string,
  method: string,
  userId: string | null,
): void {
  const entry = {
    event: "composio_mcp_non_2xx",
    service: "paperclip-adapter",
    level: "warn",
    timestamp: new Date().toISOString(),
    metadata: {
      url,
      method,
      status,
      statusText,
      cfRay: cfRay ?? "MISSING",
      userId: userId ?? "UNSET",
      bodyExcerpt: body.length > 500 ? body.slice(0, 500) + " [TRUNCATED]" : body,
    },
  };
  try {
    console.warn(JSON.stringify(entry));
  } catch {
    // Fallback: structured log write failed, emit raw
    console.warn(
      `[composio_mcp_non_2xx] status=${status} cfRay=${cfRay ?? "MISSING"} url=${url} body=${body.slice(0, 200)}`,
    );
  }
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;

  const raw = parseObject(config) as ComposioMcpConfig;

  const baseUrl = asString(raw.baseUrl, "").trim();
  const apiKey = asString(raw.apiKey, "").trim();
  const sessionId = raw.sessionId != null ? String(raw.sessionId) : null;
  const mcpConfigId = raw.mcpConfigId != null ? String(raw.mcpConfigId) : null;
  const explicitPath = raw.path != null ? String(raw.path) : null;
  const userIdPrefix = raw.userIdPrefix != null ? String(raw.userIdPrefix) : null;
  const extraHeaders = parseObject(raw.headers) as Record<string, string>;
  const timeoutMs = asNumber(raw.timeoutMs, 30000);
  const acceptHeader = asString(raw.acceptHeader, COMPOSIO_ACCEPT_DEFAULT);
  const extraBody = parseObject(raw.extraBody);

  if (!baseUrl) throw new Error("composio_mcp adapter missing baseUrl");
  if (!apiKey) throw new Error("composio_mcp adapter missing apiKey");

  const targetUrl = buildTargetUrl(baseUrl, explicitPath, sessionId, mcpConfigId);
  const mcpMatch = isComposioMcpPath(new URL(targetUrl).pathname);
  const matchedPattern = mcpMatch?.pattern ?? "unknown";

  // user_id normalization guard
  const rawUserId =
    (context as Record<string, unknown>)?.userId ??
    (context as Record<string, unknown>)?.["user_id"] ??
    agent.id;
  const normalizedUserId = normalizeUserId(String(rawUserId), userIdPrefix);

  // Build request body
  const body: Record<string, unknown> = {
    runId,
    agentId: agent.id,
    userId: normalizedUserId,
    ...extraBody,
  };

  // Merge context into body (context may contain additional tool params)
  if (context && typeof context === "object") {
    for (const [k, v] of Object.entries(context as Record<string, unknown>)) {
      if (!(k in body)) {
        body[k] = v;
      }
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": acceptHeader,
    "x-api-key": apiKey,
    ...extraHeaders,
  };

  // Controller for timeout
  const controller = new AbortController();
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let responseBody = "";
  let cfRay: string | null = null;
  let status = 0;
  let statusText = "";

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal as AbortSignal,
    });

    status = res.status;
    statusText = res.statusText;
    cfRay = res.headers.get("cf-ray") ?? null;

    // Read response body for logging on non-2xx
    responseBody = await res.text();

    if (!res.ok) {
      structuredNon2xxLog(
        status,
        statusText,
        cfRay,
        responseBody,
        targetUrl,
        "POST",
        normalizedUserId,
      );
      throw new Error(
        `Composio MCP invoke failed: HTTP ${status} ${statusText} [cf-ray: ${cfRay ?? "N/A"}]`,
      );
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `Composio MCP ${matchedPattern} → ${targetUrl} [${status}]`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      msg.includes("aborted") || msg.includes("timeout") || msg === "";

    if (isTimeout) {
      structuredNon2xxLog(
        0,
        "Request Timeout",
        null,
        `Timeout after ${timeoutMs}ms`,
        targetUrl,
        "POST",
        normalizedUserId,
      );
      return {
        exitCode: 2,
        signal: "SIGKILL",
        timedOut: true,
        summary: `Composio MCP ${matchedPattern} → timeout after ${timeoutMs}ms`,
      };
    }

    // Distinguish non-2xx (already logged) from other errors
    if (status >= 200 && status < 300) {
      structuredNon2xxLog(
        status,
        statusText,
        cfRay,
        responseBody || msg,
        targetUrl,
        "POST",
        normalizedUserId,
      );
    }

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      summary: `Composio MCP ${matchedPattern} → ${msg}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
