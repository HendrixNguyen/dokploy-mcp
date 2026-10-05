/**
 * Schema fragments shared across tool definitions.
 *
 * Every list tool takes `response_format`; every paginated tool takes `limit`/`offset`.
 * Defining them once keeps the tool surface consistent and prevents drift between the
 * 85 tool schemas.
 */

import { z } from "zod";
import { DEFAULT_LOG_TAIL, DEFAULT_PAGE_SIZE, MAX_LOG_TAIL, MAX_PAGE_SIZE } from "../constants.js";

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: 'markdown' for human-readable text, 'json' for machine-readable data");

export const PaginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Maximum rows to return (1-${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE})`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of rows to skip. Use the previous response's `next_offset` to continue"),
};

/** Log tailing, shared by every `*_logs` tool. */
export const LogTailSchema = {
  tail: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_TAIL)
    .default(DEFAULT_LOG_TAIL)
    .describe(
      `Number of most recent log lines to return (1-${MAX_LOG_TAIL}, default ${DEFAULT_LOG_TAIL}). ` +
        "Raise only when the default does not contain the error.",
    ),
  search: z
    .string()
    .optional()
    .describe("Only return lines containing this substring"),
};

/**
 * Confirmation gate for mutating tools.
 *
 * MCP annotations (`destructiveHint` etc.) are hints the client may ignore, so the guard
 * that actually matters lives in the handler: the tool refuses before calling the API.
 *
 * Defaults to `false` rather than being listed as `required`. An agent must still actively
 * pass `confirm: true` to proceed — the default only decides what happens when the argument
 * is omitted, and omitting it then produces the handler's actionable "refused, and here is
 * what it would have done" message instead of a bare JSON-RPC schema error. Root-level
 * discriminated unions cannot advertise `required` in JSON Schema at all, so requiring it
 * would have been inconsistent across the tool set for no safety gain.
 */
export const ConfirmSchema = z
  .boolean()
  .default(false)
  .describe(
    "Must be set to true to confirm. Defaults to false, in which case the tool refuses and " +
      "changes nothing, and states what it would have done.",
  );

/** Dokploy ids are opaque strings (nanoid-style, ~21 chars). Keep them as strings. */
export const IdSchema = z.string().min(1).describe("The Dokploy id");

/** `appName` constraint enforced by Dokploy: 1-63 chars of [a-zA-Z0-9._-]. */
export const AppNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-zA-Z0-9._-]+$/, "Only letters, digits, dots, underscores and hyphens")
  .describe(
    "Container/app identifier, 1-63 chars of letters, digits, dot, underscore or hyphen. " +
      "This is what Docker and Traefik see, so it must be unique per instance.",
  );

/**
 * The character set Dokploy accepts for generated database passwords. Sending a
 * character outside it fails zod validation on the server, so restricting it client-side
 * turns a round-trip rejection into immediate feedback.
 */
export const PASSWORD_ALLOWED_CHARS = /^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/;

export const PasswordSchema = z
  .string()
  .min(1)
  .regex(
    PASSWORD_ALLOWED_CHARS,
    "Only letters, digits and @#%^&*()_+-=[]{}|;:,.<>?~` are accepted by Dokploy",
  )
  .describe("Database password. Allowed characters are limited by Dokploy's own validation");

/** Compose file / raw YAML payload. */
export const ComposeFileSchema = z
  .string()
  .min(1)
  .describe("Raw docker-compose YAML");

export type ResponseFormatInput = z.infer<typeof ResponseFormatSchema>;
