import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const composioMcpAdapter: ServerAdapterModule = {
  type: "composio_mcp",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# composio_mcp agent configuration

Adapter: composio_mcp

Dedicated adapter for Composio MCP tool routing endpoints.
Supports both URL patterns used by the Composio MCP protocol:
  - /tool_router/{session}/mcp  (session-based routing)
  - /v3/mcp/{mcp_config_id}/mcp  (config-based routing)

Core fields:
- baseUrl (string, required): Composio API base URL (e.g. https://api.composio.io)
- apiKey (string, required): Composio API key
- sessionId (string, optional): Session ID for /tool_router/{session}/mcp pattern
- mcpConfigId (string, optional): MCP config ID for /v3/mcp/{mcp_config_id}/mcp pattern
- userIdPrefix (string, optional): Prefix for user_id normalization (prevents double-prefix drift)
- headers (object, optional): Additional request headers
- timeoutMs (number, optional): Request timeout in milliseconds (default: 30000)
- acceptHeader (string, optional): Accept header value (default: application/json, text/event-stream)

Auto-injected behaviors:
- Accept header set to "application/json, text/event-stream" when not explicitly provided
- x-api-key header injected from config.apiKey
- user_id normalization guard strips existing prefix before applying userIdPrefix
- Non-2xx responses logged with cf-ray, UTC timestamp, and body
`,
};
