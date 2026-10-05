/**
 * Shared response shaping: pagination normalisation, Markdown/JSON rendering, truncation.
 *
 * Every list tool funnels through here so no tool reimplements pagination or size limits.
 */

import { CHARACTER_LIMIT, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./constants.js";
import type { Paginated } from "./types.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/**
 * Declared as a type alias rather than an interface on purpose: a type alias carries an
 * implicit index signature, so `PageEnvelope<T>` is assignable to `Record<string, unknown>`
 * and can be used directly as a tool's `structuredContent`. An interface is not.
 */
export type PageEnvelope<T> = {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
};

/**
 * Dokploy returns only `{ items, total }`. This adds the `has_more` / `next_offset`
 * fields a caller needs to page, derived from what came back rather than requested —
 * the server is the authority on what exists.
 */
export function paginate<T>(
  payload: Paginated<T> | T[] | null | undefined,
  limit: number,
  offset: number,
): PageEnvelope<T> {
  const items = Array.isArray(payload) ? payload : (payload?.items ?? []);
  const total = Array.isArray(payload) ? payload.length : (payload?.total ?? items.length);
  const hasMore = offset + items.length < total;
  const envelope: PageEnvelope<T> = {
    total,
    count: items.length,
    offset,
    items,
    has_more: hasMore,
  };
  if (hasMore) envelope.next_offset = offset + items.length;
  return envelope;
}

/** Clamps a requested page size into the range Dokploy accepts (1..100). */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

export function clampOffset(offset: number | undefined): number {
  if (offset === undefined || Number.isNaN(offset) || offset < 0) return 0;
  return Math.trunc(offset);
}

/* ------------------------------------------------------------- rendering */

/** A single row of a rendered table: loose keys, because it comes from arbitrary JSON. */
export type Row = Record<string, unknown>;

/**
 * Field names whose values are credentials.
 *
 * Every name here was read off the pinned v0.30.8 OpenAPI document rather than guessed, so
 * the list tracks what Dokploy actually returns. Substring matching is deliberate: it lets
 * `databaseRootPassword`, `postgresPassword` and `currentPassword` share one entry.
 *
 * `token` is matched in its specific forms instead of as a bare substring because
 * `tokenEndpoint` / `tokenEndpointAuthentication` are OAuth provider config, not secrets,
 * and redacting them would hide settings an agent legitimately needs to read.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /accesstoken/i,
  /refreshtoken/i,
  /apitoken/i,
  /apptoken/i,
  /bottoken/i,
  /^token$/i,
  /privatekey/i,
  /apikey/i,
  /accesskey/i,
  /credential/i,
  /connectionstring/i,
  /^dsn$/i,
  /^licensekey$/i,
  // Env var containers: `env`, `previewEnv`, `envVariables`. Matched as whole or suffix
  // so `environmentId`, `accessedEnvironments` and `canCreateEnvironments` stay readable.
  /^env$/i,
  /env$/i,
  /envvariables/i,
];

/**
 * `apiKeyId`, `sshKeyId`, `environmentId` name an identifier, not a credential — and an
 * agent has to be able to read an id in order to use it in the next call.
 */
const IDENTIFIER_SUFFIX = /id$/i;

export const REDACTED = "__redacted__";

export function isSecretKey(key: string): boolean {
  if (IDENTIFIER_SUFFIX.test(key)) return false;
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Replaces credential values anywhere in a payload, recursively.
 *
 * Every Dokploy "get one" procedure returns secrets in plaintext — `env` and `buildSecrets`
 * on an application, `databasePassword` on an engine, `refreshToken` on a compose stack. Any
 * tool that forwards a raw row into `structuredContent` would therefore put production
 * secrets into the model's context. Applying this once at the single point where every
 * successful tool result is built is what makes that safe by default rather than by
 * remembering to do it in 87 handlers.
 */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date || value instanceof URL) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redactSecrets(item);
  }
  return out as T;
}

/** Compact single-line rendering of a row: `**UI** (orx5AvUc…) · done`. */
export function renderRow(row: Row, keys: readonly string[]): string {
  const primary = row[keys[0] ?? ""];
  const idKey = keys[keys.length - 1] ?? "";
  const id = row[idKey];
  const head = primary === undefined || primary === null ? "" : escapeInline(primary);
  const headMd = head ? `**${head}**` : "";
  const idMd = typeof id === "string" && id ? ` (${truncateId(escapeInline(id))})` : "";
  return `${headMd}${idMd}`;
}

/** `orx5AvUcI14WNpxA8sdWY` -> `orx5AvUcI14WNpxA8sdWY` (already short enough) or a prefix
 *  when the id is long. Ids are echoed in full because an agent must be able to paste
 *  them into the next call. */
export function truncateId(id: string): string {
  return id.length <= 40 ? id : `${id.slice(0, 37)}...`;
}

export function bulletList(items: string[]): string {
  return items.map((line) => `- ${line}`).join("\n");
}

export function heading(text: string): string {
  return `## ${text}`;
}

/** Renders an ISO timestamp as a short readable string, tolerating null/undefined. */
export function humanTime(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/**
 * Drops keys that are null/undefined/empty so Markdown rows stay readable, and keeps
 * JSON output free of noise. Keys listed in `omit` are always dropped.
 */
export function compact(row: Row, omit: readonly string[] = []): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (omit.includes(key)) continue;
    if (value === null || value === undefined) continue;
    if (value === "") continue;
    out[key] = value;
  }
  return out;
}

export interface RenderOptions<T extends Record<string, unknown>> {
  format: ResponseFormat;
  /** Markdown title. */
  title: string;
  /** Builds the Markdown body from the structured payload. */
  markdown: (data: T) => string;
  /** Structured payload; also returned as `structuredContent`. Must be an object —
   *  MCP's `structuredContent` is a record, and it is what declares the tool's output
   *  shape to clients that read it. */
  structured: T;
  /** Used when there is nothing to show. */
  empty?: string;
  /** Whether `structured` is empty enough to report `empty` instead. */
  isEmpty?: (data: T) => boolean;
}

/**
 * Single exit point for a successful tool result: renders text, enforces the character
 * limit, and attaches `structuredContent` for clients that use it.
 *
 * Redaction happens here, once, rather than in each tool. Tool authors build `structured`
 * from whatever the API returned and rarely think about `env` or `buildSecrets`; putting the
 * guarantee at the choke point is what makes it hold for the tools nobody has audited.
 *
 * Text and `structuredContent` get separate size budgets. Truncating the text alone would
 * leave the structured payload unbounded for any client that reads it instead.
 *
 * Generic over the payload so a caller's `markdown` callback receives its own row type
 * rather than having to re-cast it.
 */
export function renderResult<T extends Record<string, unknown>>(
  options: RenderOptions<T>,
): {
  content: [{ type: "text"; text: string }];
  structuredContent: T;
} {
  const { format, title, markdown, empty, isEmpty } = options;
  const structured = redactSecrets(options.structured);

  if (isEmpty?.(structured) && empty) {
    return {
      content: [{ type: "text", text: empty }],
      structuredContent: capStructured(structured),
    };
  }

  let text =
    format === "json" ? JSON.stringify(structured, null, 2) : `${heading(title)}\n\n${markdown(structured)}`;

  if (text.length > CHARACTER_LIMIT) {
    const note =
      `\n\n_Response exceeded ${CHARACTER_LIMIT} characters and was truncated. ` +
      "Narrow the query (smaller \`limit`, a more specific \`q`, or a narrower \`tail`) " +
      "to see the rest._";
    text = text.slice(0, Math.max(0, CHARACTER_LIMIT - note.length)) + note;
  }

  return { content: [{ type: "text", text }], structuredContent: capStructured(structured) };
}

/**
 * Bounds `structuredContent` to the same budget as the rendered text.
 *
 * Items are dropped from the end — the tail of a listing is the least useful part, and
 * `items` is the only shape where dropping the tail is well defined.
 *
 * The markers that record the truncation are part of the object being measured, so the
 * cap is checked against what actually ships rather than against a payload that then
 * grows by the very fields explaining why it was cut.
 */
function capStructured<T extends Record<string, unknown>>(structured: T): T {
  const fits = (candidate: unknown): boolean =>
    JSON.stringify(candidate).length <= CHARACTER_LIMIT;

  if (fits(structured)) return structured;
  if (!Array.isArray(structured.items)) {
    return { ...structured, truncated: true } as T;
  }

  const items = structured.items as unknown[];
  const withMarkers = (kept: unknown[]): Record<string, unknown> => ({
    ...structured,
    count: kept.length,
    items: kept,
    has_more: true,
    truncated: true,
    ...(typeof structured.next_offset === "number"
      ? { next_offset: Number(structured.offset ?? 0) + kept.length }
      : {}),
  });

  let keep = items.length;
  while (keep > 0 && !fits(withMarkers(items.slice(0, keep)))) {
    keep -= 1;
  }
  if (keep === items.length) return structured;
  return withMarkers(items.slice(0, keep)) as T;
}

/**
 * Escapes a value for safe inclusion in a Markdown table cell or inline bold span.
 *
 * Dokploy fields are user-controlled: an application name or domain can contain a newline,
 * a pipe, or a backtick. Without escaping, a value like `"a\n| injected | row"` breaks out
 * of the table and renders as a row the agent reads as real data, and a bare backtick lets
 * a value close a code span and start one that hides text from the reader. Newlines become
 * spaces because a cell is a single line by definition.
 */
export function escapeInline(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\r\n?|\n/g, " ");
}

/** Markdown table from a list of rows and column definitions. */
export function table(rows: Row[], columns: readonly { key: string; label: string }[]): string {
  if (rows.length === 0) return "_none_";
  const header = `| ${columns.map((c) => c.label).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => {
    const cells = columns.map((column) => {
      const value = row[column.key];
      if (value === undefined || value === null || value === "") return "—";
      if (typeof value === "boolean") return value ? "yes" : "no";
      return escapeInline(value);
    });
    return `| ${cells.join(" | ")} |`;
  });
  return [header, divider, ...body].join("\n");
}
