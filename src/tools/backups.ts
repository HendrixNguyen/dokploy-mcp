/**
 * Backup, storage destination and schedule tools.
 *
 * Backups in Dokploy are three separate concepts that the API keeps in one namespace:
 *   - a **destination** — an S3-compatible bucket holding the files
 *   - a **backup**      — a schedule plus a pointer to one source resource
 *   - a **schedule**    — the cron entry that runs a backup, listed by the resource's type
 *
 * `backup.create` is where this API is worst. Its body is a single flat object with nineteen
 * keys where the correct subset depends on two enums at once, and it requires `database` and
 * `databaseType` even for a compose backup — whose `databaseType` has no matching member in
 * the enum. An agent that sends `postgresId` with `backupType: "compose"` gets a 400 that
 * names none of the real problem.
 *
 * So the input here is a `z.discriminatedUnion` on `backupType`. The engine id field and
 * `databaseType` are stated once and derived per branch, and a compose backup structurally
 * cannot carry a `postgresId`: the wrong combination is rejected at the tool boundary with a
 * message that names the field, before any request is made.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { humanTime, paginate, renderResult, table } from "../format.js";
import {
  ConfirmSchema,
  IdSchema,
  PaginationSchema,
  ResponseFormatSchema,
} from "../schemas/common.js";
import {
  defineTool,
  DISRUPTIVE,
  DESTRUCTIVE,
  READ_ONLY,
  requireConfirmation,
  WRITE,
  type ToolContext,
  type ToolResult,
} from "./registry.js";

const DATABASE_TYPES = ["postgres", "mariadb", "mysql", "mongo", "web-server", "libsql"] as const;

/** `additionalFlags` on `destination.create` is an rclone flag list; the API constrains it. */
const FLAG_PATTERN = /^--[a-zA-Z0-9-]+(=[a-zA-Z0-9._:/@-]+)?$/;

/**
 * The per-engine id field for each `databaseType`.
 *
 * `web-server` has no dedicated key in the body, so for that engine the source id travels in
 * the required `database` field alone — which is why `database` is derived from `targetId`
 * rather than left to the caller.
 */
const ENGINE_ID_FIELD: Record<(typeof DATABASE_TYPES)[number], string | undefined> = {
  postgres: "postgresId",
  mariadb: "mariadbId",
  mysql: "mysqlId",
  mongo: "mongoId",
  libsql: "libsqlId",
  "web-server": undefined,
};

/** The schedule kinds `schedule.list` is keyed by. */
const SCHEDULE_TYPES = ["application", "compose", "server", "dokploy-server"] as const;

/** Fields every backup schedule needs, whichever kind of source it points at. */
const BackupCommon = {
  schedule: z
    .string()
    .min(1)
    .describe(
      "Cron expression for when the backup runs, e.g. \"0 2 * * *\" for 02:00 daily. " +
        "Interpreted in the Dokploy instance's timezone.",
    ),
  prefix: z
    .string()
    .min(1)
    .describe("Filename prefix for the stored object, e.g. \"prod-postgres\""),
  destinationId: z
    .string()
    .min(1)
    .describe("Destination to upload to, from dokploy_list_backup_destinations"),
  enabled: z.boolean().default(true).describe("Whether the schedule is active. Default true"),
  keepLatestCount: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Delete older backups beyond this many. Omit to keep everything"),
  userId: z.string().min(1).optional().describe("Owning user id. Defaults to the API key's user"),
  includeEncryptionKey: z
    .boolean()
    .default(false)
    .describe("Also store the database's encryption key alongside the dump. Default false"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Free-form object stored with the backup record"),
  confirm: ConfirmSchema,
};

/**
 * Agent-facing input for `dokploy_create_backup`, discriminated on `backupType`.
 *
 * Modelled here rather than in `schemas/` because only this tool consumes it: it exists to
 * make a flat nineteen-field endpoint safe to call, which is not reusable elsewhere.
 */
const CreateBackupSchema = z.discriminatedUnion("backupType", [
  z
    .object({
      backupType: z.literal("database"),
      databaseType: z
        .enum(DATABASE_TYPES)
        .describe("Which engine to dump. Decides which engine id field Dokploy reads"),
      targetId: z
        .string()
        .min(1)
        .describe("The database id, per `databaseType` (postgresId, mysqlId, …)"),
      ...BackupCommon,
    })
    .strict(),
  z
    .object({
      backupType: z.literal("compose"),
      targetId: z.string().min(1).describe("The composeId to back up"),
      serviceName: z.string().min(1).describe("Which compose service to back up"),
      databaseType: z
        .enum(DATABASE_TYPES)
        .default("web-server")
        .describe(
          "Dokploy requires this field on every backup and its enum has no 'compose' member. " +
            "'web-server' is the only non-engine value and is what a compose service backup " +
            "uses; override it only if your instance disagrees.",
        ),
      ...BackupCommon,
    })
    .strict(),
]);

type CreateBackupInput = z.infer<typeof CreateBackupSchema>;

/** Flattens either branch into the exact body `backup.create` expects. */
function backupBody(input: CreateBackupInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schedule: input.schedule,
    prefix: input.prefix,
    destinationId: input.destinationId,
    enabled: input.enabled,
    includeEncryptionKey: input.includeEncryptionKey,
    backupType: input.backupType,
    databaseType: input.databaseType,
    // `database` is required by the endpoint and is the source resource's id. It equals
    // `targetId` in both branches, so it is derived rather than asked for twice.
    database: input.targetId,
  };
  if (input.keepLatestCount !== undefined) body.keepLatestCount = input.keepLatestCount;
  if (input.userId !== undefined) body.userId = input.userId;
  if (input.metadata !== undefined) body.metadata = input.metadata;

  if (input.backupType === "compose") {
    body.composeId = input.targetId;
    body.serviceName = input.serviceName;
  } else {
    const field = ENGINE_ID_FIELD[input.databaseType];
    if (field) body[field] = input.targetId;
  }
  return body;
}

function itemsOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  const items = (payload as { items?: unknown[] } | null)?.items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function registerBackups(server: McpServer, context: ToolContext): void {
  /* ------------------------------------------------------------ create */

  defineTool(
    server,
    context,
    "dokploy_create_backup",
    {
      title: "Create A Backup Schedule",
      description: `Schedule recurring backups of a database or a compose service into a storage
destination.

The raw endpoint takes one flat object of nineteen fields whose correct subset depends on
\`backupType\` *and* \`databaseType\`, and it rejects a mismatched combination with an error
that names none of the real cause. This tool takes \`backupType\` and the two ids it implies:

  - \`backupType: 'database'\` -> send \`databaseType\` + \`targetId\`; the right engine id field
    (\`postgresId\`, \`mysqlId\`, …) is derived from \`databaseType\`
  - \`backupType: 'compose'\`  -> send \`targetId\` (the composeId) + \`serviceName\`

Both branches are validated independently, so a compose backup cannot carry a \`postgresId\`:
the mismatch is refused here, before anything is sent.

Set \`confirm: true\` — without it the tool refuses and creates nothing.

Args:
  - backupType ('database' | 'compose', required): What is being backed up. Selects which of
    the remaining fields apply; the other branch's fields are rejected.
  - databaseType ('postgres' | 'mariadb' | 'mysql' | 'mongo' | 'web-server' | 'libsql',
    required when backupType is 'database'): The engine. Decides which id field is sent.
  - targetId (string, required): The id of the thing to back up — a database id for
    backupType 'database', the composeId for 'compose'.
  - serviceName (string, required when backupType is 'compose'): The compose service to dump
  - databaseType for compose backups (optional, default 'web-server'): Dokploy requires this
    field on every backup and offers no 'compose' member in the enum. 'web-server' is the
    only non-engine value; override only if your instance disagrees.
  - schedule (string, required): Cron expression, e.g. "0 2 * * *" for 02:00 daily
  - prefix (string, required): Filename prefix for the stored object
  - destinationId (string, required): Where to upload, from dokploy_list_backup_destinations
  - enabled (boolean, optional, default true): Whether the schedule is active
  - keepLatestCount (number, optional): Prune older backups beyond this count
  - userId (string, optional): Owning user. Defaults to the API key's user.
  - includeEncryptionKey (boolean, optional, default false): Store the database's encryption
    key with the dump. Off by default because it writes a secret into object storage.
  - metadata (object, optional): Free-form data stored with the backup record
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: the created backup record, including its \`backupId\`

Examples:
  - Use when: "back up prod postgres every night" ->
    { backupType: "database", databaseType: "postgres", targetId: "…",
      schedule: "0 2 * * *", prefix: "prod-pg", destinationId: "…", confirm: true }
  - Use when: "also back up the api service's volumes" ->
    { backupType: "compose", targetId: "…", serviceName: "api",
      schedule: "0 3 * * 0", prefix: "stack-api", destinationId: "…", confirm: true }
  - Don't use when: you need one backup right now -> this creates a recurring schedule; the
    engine-specific \`backup.manualBackup*\` procedures run one immediately

Error Handling:
  - 400 with a field error -> the id and the engine disagree; re-read them with
    dokploy_resolve_service
  - 404 -> the destinationId or the target id does not exist
  - Creating a backup does not run one. The first upload happens at the next cron tick.`,
      inputSchema: CreateBackupSchema,
      annotations: WRITE,
    },
    async (input): Promise<ToolResult> => {
      const what =
        input.backupType === "compose"
          ? `service "${input.serviceName}" of compose ${input.targetId}`
          : `${input.databaseType} database ${input.targetId}`;
      const refusal = requireConfirmation(
        input.confirm,
        `Creating this backup schedule uploads ${what} to destination ${input.destinationId} ` +
          `every time "${input.schedule}" fires, and ${input.keepLatestCount === undefined ? "keeps every copy forever" : `keeps only the latest ${input.keepLatestCount}`}. ` +
          (input.includeEncryptionKey
            ? "It also stores the database's encryption key in that bucket, which is a secret " +
              "written to third-party storage."
            : "No encryption key is stored.") +
          " This also starts costing money and bandwidth as soon as it fires.",
        "Confirm the cron expression and destination with the user, then call it again with confirm: true.",
      );
      if (refusal) return refusal;

      const body = backupBody(input);
      const created = await context.client.mutation<Record<string, unknown>>("backup.create", body);
      const backupId = field(created ?? {}, "backupId", "id");

      return renderResult({
        format: "markdown",
        title: `Created backup schedule for ${what}`,
        structured: { backup: created, sent: body },
        markdown: () =>
          [
            `- **Source**: ${what}`,
            `- **Schedule**: \`${input.schedule}\``,
            `- **Prefix**: \`${input.prefix}\``,
            `- **Destination**: \`${input.destinationId}\``,
            `- **Enabled**: ${input.enabled ? "yes" : "no"}`,
            `- **Retention**: ${input.keepLatestCount ?? "keep every copy"}`,
            `- **Encryption key stored**: ${input.includeEncryptionKey ? "yes" : "no"}`,
            `- **backupId**: \`${backupId === undefined ? "not returned" : String(backupId)}\``,
            "",
            "### Body sent to backup.create",
            "```json\n" + JSON.stringify(body, null, 2) + "\n```",
            "",
            "_Nothing has run yet — the first backup happens at the next cron tick._",
          ].join("\n"),
      });
    },
  );

  /* -------------------------------------------------- list backup files */

  defineTool(
    server,
    context,
    "dokploy_list_backup_files",
    {
      title: "List Files Stored In A Backup Destination",
      description: `List the backup objects held in a storage destination — what is actually there,
how large, and when it was written.

Use this to answer "did last night's backup land?" without restoring anything. Note that the
API marks \`search\` as required; this tool defaults it to an empty string, which matches
every object, so you can omit it.

Args:
  - destinationId (string, required): The destination to inspect
  - search (string, optional, default ""): Substring filter on the object name
  - serverId (string, optional): Restrict to one Dokploy server's uploads
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "total": 7, "count": 7, "offset": 0, "items": [ { "Key": "prod-pg-2026-10-01.dump",
    "Size": 1048576, "LastModified": "2026-10-01T…" } ], "has_more": false }

Examples:
  - Use when: "did the nightly backup run?" -> list, then look at the newest \`LastModified\`
  - Use when: "how much space are my backups using?" -> read \`Size\`
  - Don't use when: you want to change the schedule -> use dokploy_create_backup or
    dokploy_list_schedules

Error Handling:
  - 404 -> no destination with that id
  - 400 -> the destination's credentials are wrong or the bucket is unreachable
  - An empty list is normal for a destination nothing has uploaded to yet
  - Listing does not read object contents, so a corrupt backup still appears here`,
      inputSchema: z
        .object({
          destinationId: IdSchema.describe("The destination to inspect"),
          search: z
            .string()
            .default("")
            .describe("Substring filter on the object name. Empty matches everything"),
          serverId: z
            .string()
            .min(1)
            .optional()
            .describe("Restrict to one Dokploy server's uploads"),
          ...PaginationSchema,
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("backup.listBackupFiles", {
        destinationId: input.destinationId,
        // The endpoint requires `search`; the client drops undefined params, so it is always
        // sent explicitly rather than relying on a default surviving to the wire.
        search: input.search,
        serverId: input.serverId,
      });
      const all = itemsOf(payload);
      const window = all.slice(input.offset, input.offset + input.limit);
      const envelope = paginate(window, input.limit, input.offset);
      const structured: Record<string, unknown> = {
        destinationId: input.destinationId,
        total: all.length,
        count: envelope.count,
        offset: input.offset,
        items: window,
        has_more: envelope.has_more,
      };
      if (envelope.next_offset !== undefined) structured.next_offset = envelope.next_offset;

      return renderResult({
        format: input.response_format,
        title: `Backup files in ${input.destinationId}${input.search ? ` matching "${input.search}"` : ""} (${window.length}/${all.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: input.search
          ? `No backup files in ${input.destinationId} match "${input.search}".`
          : `Nothing has been uploaded to ${input.destinationId} yet.`,
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((object) => ({
            key: String(field(object, "Key", "key", "name") ?? "—"),
            size: String(field(object, "Size", "size") ?? "—"),
            lastModified: humanTime(field(object, "LastModified", "lastModified")),
          }));
          return table(rows, [
            { key: "key", label: "Object" },
            { key: "size", label: "Size" },
            { key: "lastModified", label: "Modified" },
          ]);
        },
      });
    },
  );

  /* --------------------------------------------------------- delete backup */

  defineTool(
    server,
    context,
    "dokploy_delete_backup",
    {
      title: "Delete A Backup Schedule",
      description: `Delete a backup record, removing its schedule.

This does not delete the objects already uploaded — the files stay in the destination bucket
and continue to cost storage. Remove those separately if you meant to reclaim the space.

Set \`confirm: true\` — without it the tool refuses and deletes nothing.

Args:
  - backupId (string, required): The backup record to delete
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: Dokploy's response, usually \`true\`

Examples:
  - Use when: "stop backing up that old database" -> { backupId: "…", confirm: true }
  - Use when: a backup points at a service that was deleted
  - Don't use when: you want to free storage -> this leaves the uploaded files in place; use
    dokploy_list_backup_files and delete them in the bucket

Error Handling:
  - 404 -> no backup with that id
  - A backup currently mid-run is not stopped by deleting its record`,
      inputSchema: z
        .object({
          backupId: z.string().min(1).describe("The backup record to delete"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async ({ backupId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `Deleting backup ${backupId} stops the schedule from firing again. Files already ` +
          "uploaded to the destination are left in the bucket and keep costing storage — this " +
          "cannot be undone without recreating the schedule.",
        "Confirm the backupId, then call it again with confirm: true.",
      );
      if (refusal) return refusal;

      const result = await context.client.mutation<unknown>("backup.remove", { backupId });
      return renderResult({
        format: "markdown",
        title: `Deleted backup ${backupId}`,
        structured: { backupId, deleted: true, result },
        markdown: () =>
          [
            `- **backupId**: \`${backupId}\``,
            "- **Result**: deleted",
            "- The schedule will not fire again. Uploaded files remain in the destination bucket.",
          ].join("\n"),
      });
    },
  );

  /* --------------------------------------------------------- destinations */

  defineTool(
    server,
    context,
    "dokploy_list_backup_destinations",
    {
      title: "List Backup Destinations",
      description: `List the storage destinations backups can be uploaded to.

Every backup and every file listing needs a \`destinationId\`, and this is where they come
from.

Args:
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: the destination rows, e.g.
  [ { "destinationId": "…", "name": "prod-backups", "provider": "s3", "bucket": "…",
      "region": "ap-southeast-1", "endpoint": "…" } ]

Examples:
  - Use when: creating a backup and you need a destinationId
  - Use when: "which bucket do my backups go to?"
  - Don't use when: you need the files inside one -> use dokploy_list_backup_files

Error Handling:
  - An empty list is normal: no destination configured means no backup can be created
  - Secrets are not returned; \`accessKey\` and \`secretAccessKey\` are write-only in this API`,
      inputSchema: z
        .object({ response_format: ResponseFormatSchema })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ response_format }): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("destination.all");
      const items = itemsOf(payload);
      const page = paginate(items, 100, 0);
      return renderResult({
        format: response_format,
        title: `Backup destinations (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty:
          "No backup destinations are configured. Create one with dokploy_create_backup_destination before any backup can run.",
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((destination) => ({
            name: String(field(destination, "name") ?? "(unnamed)"),
            provider: String(field(destination, "provider") ?? "—"),
            bucket: String(field(destination, "bucket") ?? "—"),
            region: String(field(destination, "region") ?? "—"),
            destinationId: String(field(destination, "destinationId", "id") ?? "—"),
          }));
          return table(rows, [
            { key: "name", label: "Name" },
            { key: "provider", label: "Provider" },
            { key: "bucket", label: "Bucket" },
            { key: "region", label: "Region" },
            { key: "destinationId", label: "destinationId" },
          ]);
        },
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_create_backup_destination",
    {
      title: "Create A Backup Storage Destination",
      description: `Register an S3-compatible bucket as a backup destination.

All eight credential fields are required by the endpoint — there is no partial configuration
and no "save and fill in later". The bucket must already exist and be writable; this call
does not create it.

Set \`confirm: true\` — without it the tool refuses and creates nothing. Do not echo the
credentials back in your reply to the user.

Args:
  - name (string, required): Display name for this destination
  - provider (string, required): Provider identifier. Dokploy's spec declares no enum for this
    field — use the value your instance's destination form shows for its bucket type.
  - accessKey (string, required): Access key id
  - secretAccessKey (string, required): Secret access key
  - bucket (string, required): Bucket name
  - region (string, required): Bucket region, e.g. "ap-southeast-1"
  - endpoint (string, required): S3 endpoint host, e.g. "s3.amazonaws.com"
  - additionalFlags (string[], optional, default []): Extra rclone flags. Each must look like
    "--flag" or "--flag=value" and may only contain letters, digits and . _ : / @ - in the
    value; anything else is rejected by the endpoint before it is stored.
  - serverId (string, optional): Restrict this destination to one Dokploy server
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: the created destination record, including its \`destinationId\`

Examples:
  - Use when: "store backups in the S3 bucket" -> pass all eight fields with confirm: true
  - Use when: a destination needs a non-default flag ->
    { …, additionalFlags: ["--s3-provider=Cloudflare"] }
  - Don't use when: the destination already exists -> reuse its id, or the credentials are
    stored twice and drift apart

Error Handling:
  - 400 -> a flag is malformed, or the endpoint rejects the credentials
  - Creating the destination does not verify reachability; \`destination.testConnection\` is
    the separate check for that
  - The secret is stored by Dokploy and never returned by any read tool`,
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Display name for this destination"),
          provider: z
            .string()
            .min(1)
            .describe("Provider identifier; the spec declares no enum for it"),
          accessKey: z.string().min(1).describe("Access key id"),
          secretAccessKey: z.string().min(1).describe("Secret access key"),
          bucket: z.string().min(1).describe("Bucket name"),
          region: z.string().min(1).describe("Bucket region, e.g. ap-southeast-1"),
          endpoint: z.string().min(1).describe("S3 endpoint host, e.g. s3.amazonaws.com"),
          additionalFlags: z
            .array(z.string().regex(FLAG_PATTERN, "Must look like --flag or --flag=value"))
            .default([])
            .describe("Extra rclone flags, each '--flag' or '--flag=value'. Default []"),
          serverId: z
            .string()
            .min(1)
            .optional()
            .describe("Restrict this destination to one Dokploy server"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async (input): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        input.confirm,
        `Registering destination "${input.name}" stores the supplied access key and secret for ` +
          `bucket ${input.bucket} at ${input.endpoint} on this Dokploy instance. The credentials ` +
          "are saved in the instance database and will be used by every backup pointed at this " +
          "destination.",
        "Confirm the bucket and credentials with the user, then call it again with confirm: true.",
      );
      if (refusal) return refusal;

      const body: Record<string, unknown> = {
        name: input.name,
        provider: input.provider,
        accessKey: input.accessKey,
        secretAccessKey: input.secretAccessKey,
        bucket: input.bucket,
        region: input.region,
        endpoint: input.endpoint,
        additionalFlags: input.additionalFlags,
      };
      if (input.serverId !== undefined) body.serverId = input.serverId;

      const created = await context.client.mutation<Record<string, unknown>>(
        "destination.create",
        body,
      );
      const destinationId = field(created ?? {}, "destinationId", "id");

      return renderResult({
        format: "markdown",
        title: `Created backup destination ${input.name}`,
        // The secret is deliberately not echoed back: this result is rendered to whoever ran
        // the tool, and a repeated secret is a leaked secret.
        structured: {
          destinationId,
          name: input.name,
          provider: input.provider,
          bucket: input.bucket,
          region: input.region,
          endpoint: input.endpoint,
          additionalFlags: input.additionalFlags,
        },
        markdown: () =>
          [
            `- **Name**: ${input.name}`,
            `- **Provider**: ${input.provider}`,
            `- **Bucket**: ${input.bucket}`,
            `- **Region**: ${input.region}`,
            `- **Endpoint**: ${input.endpoint}`,
            `- **Additional flags**: ${input.additionalFlags.length === 0 ? "—" : input.additionalFlags.join(" ")}`,
            `- **destinationId**: \`${destinationId === undefined ? "not returned" : String(destinationId)}\``,
            "_The access key and secret were sent and are not repeated here._",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------------- schedules */

  defineTool(
    server,
    context,
    "dokploy_list_schedules",
    {
      title: "List Schedules For One Resource",
      description: `List the schedules attached to a single resource — the cron entries Dokploy runs
for it, of any kind (backup, deploy, restart).

The endpoint is keyed by a pair, not a single id: you pass the resource's \`id\` *and* its
\`scheduleType\`. That is why this tool cannot list "all schedules" — there is no such call
in the API, and guessing a type returns an empty list that looks like "no schedules".

Ask for the type you actually want. A backup schedule is found under \`scheduleType:
'compose'\` or the application/database's own type, and appears as a row with a \`cron\`
field.

Args:
  - id (string, required): The owning resource's id — applicationId, composeId, serverId, or
    the Dokploy server id for 'dokploy-server'
  - scheduleType ('application' | 'compose' | 'server' | 'dokploy-server', required): Which
    kind of resource \`id\` refers to. This is half the primary key, not a filter.
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: the schedule rows for that resource, e.g.
  [ { "scheduleId": "…", "cron": "0 2 * * *", "enabled": true, "backupId": "…" } ]

Examples:
  - Use when: "what is on this stack's schedule?" ->
    { id: "<composeId>", scheduleType: "compose" }
  - Use when: "when does the nightly backup run?" -> read the \`cron\` field
  - Don't use when: you want every schedule on the instance -> this endpoint is per-resource;
    walk the services with dokploy_list_projects and call it for each

Error Handling:
  - 400 -> \`scheduleType\` does not match the id you passed; the two are a composite key
  - An empty list is normal: most resources have no schedules configured`,
      inputSchema: z
        .object({
          id: z
            .string()
            .min(1)
            .describe("The owning resource's id. Half the primary key together with scheduleType"),
          scheduleType: z
            .enum(SCHEDULE_TYPES)
            .describe("Which kind of resource `id` refers to. The other half of the primary key"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ id, scheduleType, response_format }): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("schedule.list", { id, scheduleType });
      const items = itemsOf(payload);
      const page = paginate(items, 100, 0);
      return renderResult({
        format: response_format,
        title: `Schedules for ${scheduleType} ${id} (${page.count})`,
        structured: { id, scheduleType, ...page },
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `No schedules are attached to ${scheduleType} ${id}.`,
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((schedule) => ({
            cron: String(field(schedule, "cron", "schedule") ?? "—"),
            enabled: schedule.enabled === false ? "no" : "yes",
            type: String(field(schedule, "type", "scheduleType") ?? "—"),
            scheduleId: String(field(schedule, "scheduleId", "id") ?? "—"),
          }));
          return table(rows, [
            { key: "cron", label: "Cron" },
            { key: "enabled", label: "Enabled" },
            { key: "type", label: "Type" },
            { key: "scheduleId", label: "scheduleId" },
          ]);
        },
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_run_schedule_now",
    {
      title: "Run A Schedule Immediately",
      description: `Fire a schedule once, right now, without waiting for its next cron tick.

This runs the real task: a backup schedule uploads a dump to its destination, a restart
schedule bounces the service, a deploy schedule starts a build. Use it to verify a schedule
works after creating it, rather than waiting a day for the first run.

Set \`confirm: true\` — without it the tool refuses and runs nothing.

Args:
  - scheduleId (string, required): The schedule to run, from dokploy_list_schedules
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: Dokploy's response, usually \`true\`

Examples:
  - Use when: "test the new nightly backup now" ->
    { scheduleId: "…", confirm: true }, then list the destination's files to see it land
  - Use when: a schedule is due in six hours and you need it sooner
  - Don't use when: you only need the schedule's cron expression -> use dokploy_list_schedules,
    which is free

Error Handling:
  - 404 -> no schedule with that id
  - The run happens asynchronously: this returning true means it was queued, not that the
    backup finished. Confirm with dokploy_list_backup_files.
  - A schedule disabled with \`enabled: false\` is still run by this tool — it acts on the
    schedule, not on whether it is active.`,
      inputSchema: z
        .object({
          scheduleId: z
            .string()
            .min(1)
            .describe("The schedule to run. Its scheduleId, not the resource id"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DISRUPTIVE,
    },
    async ({ scheduleId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `Running schedule ${scheduleId} immediately starts the real task now — a backup upload, ` +
          "a restart or a deploy, depending on what the schedule does — alongside any run that " +
          "was already in progress.",
        "Check what the schedule does with dokploy_list_schedules, then call it again with confirm: true.",
      );
      if (refusal) return refusal;

      const result = await context.client.mutation<unknown>("schedule.runManually", { scheduleId });
      return renderResult({
        format: "markdown",
        title: `Started schedule ${scheduleId}`,
        structured: { scheduleId, started: true, result },
        markdown: () =>
          [
            `- **scheduleId**: \`${scheduleId}\``,
            "- **Result**: queued for immediate execution",
            "- This returns as soon as the run is queued. Confirm the outcome with the tool that",
            "  matches the schedule type — dokploy_list_backup_files for a backup.",
          ].join("\n"),
      });
    },
  );
}
