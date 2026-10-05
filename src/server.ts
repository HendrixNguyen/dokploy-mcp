/**
 * Server assembly. Each tool group registers itself here; adding a group is one import
 * and one call.
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION, TARGETED_DOKPLOY_VERSION } from "./constants.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { ToolContext } from "./tools/registry.js";
import { registerDiscovery } from "./tools/discovery.js";
import { registerResolve } from "./tools/resolve.js";
import { registerApplications } from "./tools/applications.js";
import { registerCompose } from "./tools/compose.js";
import { registerDatabases } from "./tools/databases.js";
import { registerDomains } from "./tools/domains.js";
import { registerDeployments } from "./tools/deployments.js";
import { registerBackups } from "./tools/backups.js";
import { registerDocker } from "./tools/docker.js";
import { registerInfra } from "./tools/infra.js";
import { registerWorkflows } from "./tools/workflows.js";

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions:
        `Operate a Dokploy instance: deploy applications and compose stacks, manage the six ` +
        `database engines, configure domains, and inspect deployments.\n\n` +
        `Start with dokploy_whoami and dokploy_list_projects. Dokploy addresses everything by ` +
        `opaque id, so whenever you hold a service *name* rather than an id, call ` +
        `dokploy_resolve_service first — guessing an id produces a 404.\n\n` +
        `Verified against Dokploy v${TARGETED_DOKPLOY_VERSION}. Mutating tools require ` +
        `confirm: true and will refuse without it.`,
    },
  );

  registerDiscovery(server, context);
  registerResolve(server, context);
  registerApplications(server, context);
  registerCompose(server, context);
  registerDatabases(server, context);
  registerDomains(server, context);
  registerDeployments(server, context);
  registerBackups(server, context);
  registerDocker(server, context);
  registerInfra(server, context);
  registerWorkflows(server, context);

  return server;
}

/**
 * Stateless streamable-HTTP handler.
 *
 * Stateless means a fresh transport (and a fresh server, since `connect` binds one
 * transport to one server) per request, so concurrent clients never collide on request
 * ids. JSON responses are enabled because there is no session to stream over.
 *
 * Uses node:http directly rather than express — the SDK's transport accepts standard
 * IncomingMessage/ServerResponse, so a web framework would add a dependency for nothing.
 */
export function createHttpHandler(
  config: Config,
  logger: Logger,
  createFreshServer: () => McpServer,
): http.Server {
  const allowed = new Set(config.allowedOrigins);

  /** DNS-rebinding protection: reject any Origin outside the allowlist. */
  function originAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    // A non-browser client (curl, a server-side agent) sends no Origin at all.
    if (origin === undefined) return true;
    return allowed.has(origin);
  }

  function authorised(req: http.IncomingMessage): boolean {
    if (!config.httpToken) return false;
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const [scheme, token] = header.split(" ");
    return scheme?.toLowerCase() === "bearer" && token === config.httpToken;
  }

  function refuse(res: http.ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({ error: message });
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        refuse(res, 200, "ok");
        return;
      }
      if (url.pathname !== "/mcp") {
        refuse(res, 404, `Unknown path ${url.pathname}. The MCP endpoint is /mcp.`);
        return;
      }
      if (!originAllowed(req)) {
        logger.warn(`rejected Origin ${req.headers.origin} on /mcp`);
        refuse(res, 403, "Origin not allowed");
        return;
      }
      if (!authorised(req)) {
        refuse(res, 401, "Missing or invalid bearer token");
        return;
      }

      // Stateless: no SSE stream to open. A GET here would be an SSE listener, which this
      // deployment does not support.
      if (req.method === "GET" || req.method === "DELETE") {
        refuse(res, 405, `Method ${req.method} not allowed. This server is stateless; use POST.`);
        return;
      }
      if (req.method !== "POST") {
        refuse(res, 405, `Method ${req.method} not allowed`);
        return;
      }

      let raw = "";
      try {
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 8 * 1024 * 1024) {
            refuse(res, 413, "Request body too large");
            return;
          }
        }
      } catch (error) {
        logger.error("failed to read request body", error);
        refuse(res, 400, "Could not read request body");
        return;
      }

      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        refuse(res, 400, "Request body is not valid JSON");
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => void transport.close());

      const mcpServer = createFreshServer();
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (error) {
        logger.error("error handling MCP request", error);
        if (!res.headersSent) {
          refuse(res, 500, "Internal error handling the MCP request");
        } else {
          res.end();
        }
      }
    })();
  });

  return server;
}
