/** Shared constants. */

/** Hard cap on the character length of a single tool response. */
export const CHARACTER_LIMIT = 25_000;

/** Dokploy caps `limit` at 100 and `offset` at 0 (see docs/openapi.v0.30.8.json). */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** `readLogs` accepts 1..10000. Default is deliberately modest: logs are the
 *  largest unbounded response in the API and agents rarely need more to diagnose. */
export const DEFAULT_LOG_TAIL = 200;
export const MAX_LOG_TAIL = 10_000;

/** Log reads shell out to Docker and can take far longer than a metadata read, so they
 *  get their own budget rather than being forced to share the global timeout. */
export const LOG_TIMEOUT_MS = 90_000;

/** Server identity advertised over MCP. */
export const SERVER_NAME = "dokploy-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Dokploy release this server was built and verified against. */
export const TARGETED_DOKPLOY_VERSION = "0.30.8";
