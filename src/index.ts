#!/usr/bin/env node
/**
 * Entry point. Selects a transport from the environment.
 *
 * stdio  — default. The client spawns this process; stdout carries JSON-RPC and must
 *          contain nothing else. All diagnostics go to stderr.
 * http   — stateless streamable HTTP at POST /mcp, for shared or remote deployment.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, createHttpHandler } from "./server.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { DokployClient } from "./client.js";

function build(config: Config, logger: Logger) {
  const client = new DokployClient({
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
  const context = { client, logger, config };
  return { server: createServer(context), client, context };
}

async function runStdio(config: Config, logger: Logger): Promise<void> {
  const { server } = build(config, logger);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("listening on stdio");
}

async function runHttp(config: Config, logger: Logger): Promise<void> {
  const { client } = build(config, logger);
  const handler = createHttpHandler(config, logger, () => build(config, logger).server);

  const host = process.env.HOST ?? "127.0.0.1";
  const server = handler.listen(config.port, host, () => {
    logger.info(`listening on http://${host}:${config.port}/mcp`);
  });
  server.on("error", (error: Error) => {
    logger.error("http server error", error);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    logger.info("shutting down");
    server.close(() => process.exit(0));
  });

  // A bad key should fail here, not on the first tool call.
  void client.probe().then(
    (probe) => logger.info(`connected to Dokploy ${probe.version} (${probe.status})`),
    (error: unknown) => logger.error("could not reach Dokploy at startup", error),
  );
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    // stderr, never stdout: stdout is the JSON-RPC channel.
    process.stderr.write(`\n[dokploy-mcp] Configuration error\n${(error as Error).message}\n\n`);
    process.stderr.write("See .env.example for the full list of variables.\n");
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  logger.info(`starting ${"0.1.0"} against ${config.dokployUrl} via ${config.transport}`);

  if (config.transport === "http") {
    await runHttp(config, logger);
  } else {
    await runStdio(config, logger);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[dokploy-mcp] FATAL ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
