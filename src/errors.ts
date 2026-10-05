/**
 * Dokploy failures -> text an agent can act on.
 *
 * Dokploy returns real HTTP statuses with a rich body:
 *   { message, code, data: { code, httpStatus, path, zodError }, issues: [...] }
 *
 * The `issues` array is the highest-value signal in the whole API: it names the offending
 * field and what was expected. Surfacing it verbatim is what lets an agent correct itself
 * without a retry loop.
 */

import { redact } from "./config.js";
import type { DokployErrorBody, DokployIssue, DokployZodError } from "./types.js";

export type DokployErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "TIMEOUT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_SERVER_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export class DokployError extends Error {
  override readonly name = "DokployError";
  readonly status: number;
  readonly code: DokployErrorCode;
  readonly issues: DokployIssue[];
  readonly procedure?: string;

  constructor(params: {
    status: number;
    code: DokployErrorCode;
    message: string;
    issues?: DokployIssue[];
    procedure?: string;
  }) {
    super(params.message);
    this.status = params.status;
    this.code = params.code;
    this.issues = params.issues ?? [];
    if (params.procedure) this.procedure = params.procedure;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalises Dokploy's several error-ish shapes (including the flat unauthenticated one) into one. */
export function toDokployError(
  status: number,
  body: unknown,
  procedure?: string,
  apiKey?: string,
): DokployError {
  const record = isRecord(body) ? body : {};
  const data = isRecord(record.data) ? record.data : {};

  // Unauthenticated calls return `{ message: "Unauthorized" }` with no `code` field.
  const rawCode =
    typeof record.code === "string"
      ? record.code
      : typeof data.code === "string"
        ? data.code
        : undefined;

  const code = normaliseCode(rawCode, status);
  const rawMessage =
    typeof record.message === "string"
      ? record.message
      : typeof body === "string" && body.trim().length > 0
        ? body
        : `Dokploy returned HTTP ${status} with no error message.`;

  const issues = Array.isArray(record.issues) ? (record.issues as DokployIssue[]) : [];

  // `data.zodError` is present even when `issues` is not.
  const zodError = isRecord(data.zodError) ? (data.zodError as DokployZodError) : undefined;
  if (issues.length === 0 && zodError) {
    issues.push(...issuesFromZodError(zodError));
  }

  const message = apiKey ? redact(rawMessage, apiKey) : rawMessage;
  return new DokployError({ status, code, message, issues, procedure });
}

function normaliseCode(code: string | undefined, status: number): DokployErrorCode {
  if (code) {
    const upper = code.toUpperCase();
    if (upper === "TOO_MANY_REQUESTS" || upper === "RATE_LIMIT_EXCEEDED") return "TOO_MANY_REQUESTS";
    if (upper === "UNAUTHORIZED") return "UNAUTHORIZED";
    if (upper === "FORBIDDEN") return "FORBIDDEN";
    if (upper === "NOT_FOUND") return "NOT_FOUND";
    if (upper === "BAD_REQUEST" || upper === "PARSE_ERROR") return "BAD_REQUEST";
    if (upper === "INTERNAL_SERVER_ERROR") return "INTERNAL_SERVER_ERROR";
  }
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 504:
    case 408:
      return "TIMEOUT";
    default:
      return status >= 500 ? "INTERNAL_SERVER_ERROR" : "UNKNOWN";
  }
}

function issuesFromZodError(zodError: DokployZodError): DokployIssue[] {
  const out: DokployIssue[] = [];
  for (const message of zodError.formErrors ?? []) {
    out.push({ path: [], message });
  }
  for (const [field, messages] of Object.entries(zodError.fieldErrors ?? {})) {
    for (const message of messages ?? []) {
      out.push({ path: [field], message });
    }
  }
  return out;
}

function issueLocation(issue: DokployIssue): string {
  const path = issue.path;
  if (!path || path.length === 0) return "(root)";
  return path.map((segment) => String(segment)).join(".");
}

/**
 * Builds the final text shown to the agent. Every branch tells the agent what to do next;
 * none of them leak an internal stack, and none repeat the API key.
 */
export function describeError(error: unknown, secret?: string): string {
  if (!(error instanceof DokployError)) {
    const message = error instanceof Error ? error.message : String(error);
    const safe = secret ? redact(message, secret) : message;
    return `Error: unexpected failure calling Dokploy — ${safe}`;
  }

  const where = error.procedure ? ` (procedure ${error.procedure})` : "";

  switch (error.code) {
    case "UNAUTHORIZED":
      return (
        `Error: Dokploy rejected the credentials (401)${where}. ` +
        "Check DOKPLOY_API_KEY — it must be a valid key from Settings -> API Keys on the " +
        "target instance, and DOKPLOY_URL must point at that same instance."
      );

    case "FORBIDDEN":
      return (
        `Error: the credentials are valid but not permitted to do this (403)${where}. ` +
        "The key may be scoped to a different organization than the target resource, or the " +
        "procedure requires an admin role."
      );

    case "NOT_FOUND":
      return (
        `Error: not found (404)${where}. Verify the id exists and belongs to the service type ` +
        "you assumed. Note that on this API a POST to a query procedure also returns 404, so " +
        "check you are calling the right operation."
      );

    case "TOO_MANY_REQUESTS":
      return (
        `Error: rate limited (429)${where}. The API key has a refill-based quota. ` +
        "Wait for the refill window, reduce polling (raise the log `tail` interval rather " +
        "than repeatedly calling the log tool), then retry the same call."
      );

    case "TIMEOUT":
      return `Error: Dokploy did not respond in time (${error.status})${where}. ${error.message}`;

    case "BAD_REQUEST": {
      if (error.issues.length > 0) {
        const lines = error.issues.map(
          (issue) => `  - ${issueLocation(issue)}: ${issue.message ?? "invalid value"}`,
        );
        return (
          `Error: Dokploy rejected the input (400)${where}. Fix these fields and retry:\n` +
          lines.join("\n")
        );
      }
      return `Error: Dokploy rejected the input (400)${where}. ${error.message}`;
    }

    case "NETWORK_ERROR":
      return (
        `Error: could not reach Dokploy${where}. ${error.message} ` +
        "Confirm DOKPLOY_URL is reachable from this machine."
      );

    case "INTERNAL_SERVER_ERROR":
      return (
        `Error: Dokploy failed internally (${error.status})${where}. ${error.message} ` +
        "This is a server-side fault — retry once, then check Dokploy's own logs."
      );

    default:
      return `Error: Dokploy returned ${error.status}${where}. ${error.message}`;
  }
}

/** Maps any thrown value into an `isError` tool result. */
export function errorResult(error: unknown, secret?: string): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  return {
    isError: true,
    content: [{ type: "text" as const, text: describeError(error, secret) }],
  };
}

export { safeJsonParse };
