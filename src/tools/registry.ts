/**
 * Tool registration helpers.
 *
 * Every tool goes through `defineTool` so error handling, logging and API-key redaction
 * happen in exactly one place. Without this, 85 tools each grow their own try/catch and
 * it is a matter of time before one of them forgets to redact.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import type { DokployClient } from "../client.js";
import type { Config } from "../config.js";
import { errorResult } from "../errors.js";
import type { Logger } from "../logger.js";

export interface ToolContext {
  readonly client: DokployClient;
  readonly logger: Logger;
  readonly config: Config;
}

export type ToolResult = CallToolResult;

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Changes remote state but is safe to repeat with the same arguments. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Starts, stops, restarts or otherwise disrupts a running service. */
export const DISRUPTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Removes resources or overwrites configuration. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export interface ToolConfig<Shape extends ZodType> {
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
}

export function defineTool<Shape extends ZodType>(
  server: McpServer,
  context: ToolContext,
  name: string,
  config: ToolConfig<Shape>,
  handler: (input: Shape["_output"], context: ToolContext) => Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema as never,
      annotations: config.annotations,
    },
    (async (input: unknown) => {
      try {
        return await handler(input as Shape["_output"], context);
      } catch (error) {
        // `errorResult` already maps to actionable text and redacts the API key.
        context.logger.error(`tool ${name} failed`, error);
        return errorResult(error, context.config.apiKey);
      }
    }) as never,
  );
}

/**
 * The confirmation gate for mutating tools.
 *
 * MCP annotations are documented as hints that clients must not act on, so the guard that
 * actually prevents an accidental delete lives in the handler. Returns `null` when the
 * caller may proceed, or the refusal result to return immediately.
 */
export function requireConfirmation(
  confirmed: boolean,
  consequence: string,
  remedy: string,
): ToolResult | null {
  if (confirmed) return null;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Error: refused without calling Dokploy. ${consequence}\n\n` +
          `When you are ready: ${remedy}`,
      },
    ],
  };
}
