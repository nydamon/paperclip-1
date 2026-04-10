import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

const MCP_TOOL_ROUTER_RE = /^\/tool_router\/([^/]+)\/mcp(?:\/.*)?$/;
const MCP_V3_RE = /^\/v3\/mcp\/([^/]+)\/mcp(?:\/.*)?$/;

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function validateComposioUrl(baseUrl: string, path: string): { valid: boolean; message: string } {
  try {
    const url = new URL(path.startsWith("http") ? path : `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
    const pathname = url.pathname;
    const isToolRouter = MCP_TOOL_ROUTER_RE.test(pathname);
    const isV3 = MCP_V3_RE.test(pathname);

    if (isToolRouter) {
      return { valid: true, message: `Matched /tool_router/{session}/mcp pattern (session: ${RegExp.$1 || "captured"})` };
    }
    if (isV3) {
      return { valid: true, message: `Matched /v3/mcp/{mcp_config_id}/mcp pattern` };
    }
    return {
      valid: false,
      message: `Path "${pathname}" does not match known Composio MCP patterns (/tool_router/{session}/mcp or /v3/mcp/{mcp_config_id}/mcp)`,
    };
  } catch {
    return { valid: false, message: `Could not parse URL: ${path}` };
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const baseUrl = asString(config.baseUrl, "").trim();
  const apiKey = asString(config.apiKey, "").trim();
  const sessionId = config.sessionId != null ? String(config.sessionId) : null;
  const mcpConfigId = config.mcpConfigId != null ? String(config.mcpConfigId) : null;
  const explicitPath = config.path != null ? String(config.path) : null;
  const userIdPrefix = config.userIdPrefix != null ? String(config.userIdPrefix) : null;
  const timeoutMs = asNumber(config.timeoutMs, 30000);

  // 1. baseUrl validation
  if (!baseUrl) {
    checks.push({
      code: "composio_baseurl_missing",
      level: "error",
      message: "composio_mcp adapter requires baseUrl (Composio API base, e.g. https://api.composio.io).",
      hint: "Set adapterConfig.baseUrl to your Composio API base URL.",
    });
  } else {
    try {
      const u = new URL(baseUrl);
      checks.push({
        code: "composio_baseurl_valid",
        level: "info",
        message: `baseUrl parsed OK: ${u.origin}`,
      });
    } catch {
      checks.push({
        code: "composio_baseurl_invalid",
        level: "error",
        message: `baseUrl "${baseUrl}" is not a valid URL.`,
      });
    }
  }

  // 2. API key validation
  if (!apiKey) {
    checks.push({
      code: "composio_apikey_missing",
      level: "error",
      message: "composio_mcp adapter requires apiKey.",
      hint: "Set adapterConfig.apiKey to your Composio API key.",
    });
  } else if (apiKey.length < 8) {
    checks.push({
      code: "composio_apikey_suspicious",
      level: "warn",
      message: "API key appears too short — verify it is correct.",
    });
  } else {
    checks.push({
      code: "composio_apikey_present",
      level: "info",
      message: `API key configured (${apiKey.slice(0, 4)}***${apiKey.slice(-4)}).`,
    });
  }

  // 3. URL pattern validation
  if (baseUrl && (explicitPath || sessionId || mcpConfigId)) {
    let resolvedPath = explicitPath ?? "";
    if (sessionId) resolvedPath = `/tool_router/${sessionId}/mcp`;
    if (mcpConfigId) resolvedPath = `/v3/mcp/${mcpConfigId}/mcp`;

    const urlResult = validateComposioUrl(baseUrl, resolvedPath);
    checks.push({
      code: urlResult.valid ? "composio_url_pattern_match" : "composio_url_pattern_unknown",
      level: urlResult.valid ? "info" : "warn",
      message: urlResult.message,
    });
  } else if (!explicitPath && !sessionId && !mcpConfigId) {
    checks.push({
      code: "composio_no_endpoint_configured",
      level: "warn",
      message:
        "No sessionId, mcpConfigId, or path configured. Provide one to target a specific MCP endpoint.",
      hint: "Set adapterConfig.sessionId or adapterConfig.mcpConfigId or adapterConfig.path.",
    });
  }

  // 4. Accept header note
  checks.push({
    code: "composio_accept_header",
    level: "info",
    message:
      "Accept header auto-injected as 'application/json, text/event-stream' unless overridden via acceptHeader config.",
  });

  // 5. user_id normalization note
  if (userIdPrefix) {
    checks.push({
      code: "composio_userid_normalization_active",
      level: "info",
      message: `user_id normalization active with prefix: "${userIdPrefix}"`,
    });
  }

  // 6. timeout validation
  if (timeoutMs < 0) {
    checks.push({
      code: "composio_timeout_negative",
      level: "error",
      message: `timeoutMs must be non-negative, got ${timeoutMs}`,
    });
  } else {
    checks.push({
      code: "composio_timeout_configured",
      level: "info",
      message: `timeoutMs: ${timeoutMs}ms`,
    });
  }

  // 7. Live connectivity probe
  if (baseUrl && (apiKey || sessionId || mcpConfigId)) {
    let probeUrl = baseUrl;
    if (sessionId) probeUrl = `${baseUrl.replace(/\/$/, "")}/tool_router/${sessionId}/mcp`;
    else if (mcpConfigId) probeUrl = `${baseUrl.replace(/\/$/, "")}/v3/mcp/${mcpConfigId}/mcp`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(probeUrl, {
        method: "OPTIONS",
        signal: controller.signal,
        headers: apiKey ? { "x-api-key": apiKey } : {},
      });
      // 405 = method not allowed (OPTIONS not supported but host reachable)
      // 401 = unauthorized (host reachable, key missing/invalid)
      // 200 = reachable
      if ([200, 401, 405].includes(res.status)) {
        checks.push({
          code: "composio_endpoint_reachable",
          level: "info",
          message: `Endpoint reachable at ${probeUrl} (HTTP ${res.status})`,
        });
      } else if (res.status >= 500) {
        checks.push({
          code: "composio_endpoint_server_error",
          level: "warn",
          message: `Endpoint returned HTTP ${res.status} — server-side issue`,
        });
      } else {
        checks.push({
          code: "composio_endpoint_unreachable",
          level: "warn",
          message: `Endpoint probe returned HTTP ${res.status}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        code: "composio_endpoint_probe_failed",
        level: "warn",
        message: `Connectivity probe failed: ${msg}`,
        hint: "Verify Composio API is reachable from the Paperclip server host.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
