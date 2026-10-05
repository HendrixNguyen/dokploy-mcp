/**
 * Database engine tools.
 *
 * Dokploy manages six database engines (postgres, mysql, mariadb, mongo, redis,
 * libsql). Each engine addresses its resources with a type-specific id key and
 * exposes the same verb set via <type>.<verb> procedures, with two known
 * inconsistencies:
 *
 *   - libsql has no `search` procedure; it falls back to the project-tree index.
 *   - libsql uses `saveExternalPorts` (plural) while the other five use
 *     `saveExternalPort` (singular).
 *
 * These 13 tools collapse 96 individual procedures into a single engine-
 * parameterised surface.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  clampLimit,
  clampOffset,
  paginate,
  renderResult,
  table,
  humanTime,
} from "../format.js";
import type { Paginated, ResolvedService } from "../types.js";
import {
  PaginationSchema,
  ResponseFormatSchema,
  LogTailSchema,
  ConfirmSchema,
} from "../schemas/common.js";
import {
  DatabaseTypeSchema,
  DatabaseCreateSchema,
  DatabaseUpdateSchema,
  DatabaseChangePasswordSchema,
  DatabaseExternalPortSchema,
  DATABASE_ID_KEY,
  type DatabaseType,
} from "../schemas/database.js";
import { loadServiceIndex } from "./resolve.js";
import { LOG_TIMEOUT_MS } from "../constants.js";
import {
  defineTool,
  READ_ONLY,
  WRITE,
  DISRUPTIVE,
  DESTRUCTIVE,
  requireConfirmation,
  type ToolContext,
  type ToolResult,
} from "./registry.js";

/* ----------------------------------------------------------------- helpers */

const SEARCH_PARAMS = {
  q: z.string().optional().describe("Free-text match against name and description"),
  name: z.string().optional().describe("Match the database name"),
  appName: z.string().optional().describe("Match the appName"),
  description: z.string().optional().describe("Match the description"),
  projectId: z.string().optional().describe("Narrow to this project id"),
  environmentId: z.string().optional().describe("Narrow to this environment id"),
} as const;

function procedure(type: DatabaseType, verb: string): string {
  return `${type}.${verb}`;
}

function idField(type: DatabaseType): string {
  return DATABASE_ID_KEY[type];
}

function requireDatabaseId(type: DatabaseType, input: Record<string, unknown>): string {
  const key = idField(type);
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing or empty ${key} for database type "${type}"`);
  }
  return value;
}

/**
 * Dokploy uses `saveExternalPort` for postgres/mysql/mariadb/mongo/redis and
 * `saveExternalPorts` (plural) for libsql. The inconsistency is real and
 * verified against the v0.30.8 spec.
 */
const EXTERNAL_PORT_VERB: Record<DatabaseType, string> = {
  postgres: "saveExternalPort",
  mysql: "saveExternalPort",
  mariadb: "saveExternalPort",
  mongo: "saveExternalPort",
  redis: "saveExternalPort",
  libsql: "saveExternalPorts",
};

/* ----------------------------------------------------------------- search */

const DatabaseSearchSchema = z
  .object({
    type: DatabaseTypeSchema,
    ...SEARCH_PARAMS,
    ...PaginationSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

export function registerDatabases(server: McpServer, context: ToolContext): void {

defineTool(
  server,
  context,
  "dokploy_search_databases",
  {
    title: "Search Databases",
    description: `Search database engines by name, appName or description, with pagination.

For postgres, mysql, mariadb, mongo and redis this calls the engine's native
\`search\` procedure. For libsql there is no \`search\` procedure in Dokploy's
API, so it falls back to the project-tree index and filters by type/name
instead.

Args:
  - type (enum, required): 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis' | 'libsql'
  - q (string, optional): Free-text match
  - name (string, optional): Match the database name
  - appName (string, optional): Match the appName
  - description (string, optional): Match the description
  - projectId (string, optional): Narrow to this project id
  - environmentId (string, optional): Narrow to this environment id
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "total": 2, "count": 2, "offset": 0, "items": [...], "has_more": false }

Examples:
  - Use when: "find the postgres for the API project" -> { type: "postgres", q: "API" }
  - Use when: searching libsql -> { type: "libsql", name: "main" } (uses the project-tree index)
  - Don't use when: you already hold an id -> use dokploy_get_database

Error Handling:
  - No match -> empty items array with has_more false`,
    inputSchema: DatabaseSearchSchema,
    annotations: READ_ONLY,
  },
  async (input): Promise<ToolResult> => {
    if (input.type === "libsql") {
      const index = await loadServiceIndex(context.client);
      let pool = index.filter((s) => s.type === "libsql");
      if (input.projectId) {
        pool = pool.filter((s) => s.projectId === input.projectId);
      }
      if (input.environmentId) {
        pool = pool.filter((s) => s.environmentId === input.environmentId);
      }
      if (input.q) {
        const needle = input.q.toLowerCase();
        pool = pool.filter((s) =>
          [s.name, s.appName].some((v) => typeof v === "string" && v.toLowerCase().includes(needle)),
        );
      }
      if (input.name) {
        const needle = input.name.toLowerCase();
        pool = pool.filter((s) => s.name?.toLowerCase() === needle || s.appName?.toLowerCase() === needle);
      }
      const total = pool.length;
      const items = pool.slice(input.offset, input.offset + input.limit);
      const hasMore = input.offset + items.length < total;
      const page = { total, count: items.length, offset: input.offset, items, has_more: hasMore };
      return renderResult({
        format: input.response_format,
        title: `libsql databases${input.q ? ` matching "${input.q}"` : ""} (${items.length}/${total})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `No libsql databases matched on this instance.`,
        markdown: (data) => {
          const rows = (data as { items: ResolvedService[] }).items.map((s) => ({
            name: s.name ?? s.appName ?? "(unnamed)",
            id: s.id,
            status: s.status ?? "—",
            project: s.projectName ?? "—",
            environment: s.environmentName ?? "—",
          }));
          return table(rows, [
            { key: "name", label: "Name" },
            { key: "id", label: "Id" },
            { key: "status", label: "Status" },
            { key: "project", label: "Project" },
            { key: "environment", label: "Environment" },
          ]);
        },
      });
    }

    const payload = await context.client.query<Paginated<Record<string, unknown>> | Record<string, unknown>[]>(
      procedure(input.type, "search"),
      {
        q: input.q,
        name: input.name,
        appName: input.appName,
        description: input.description,
        projectId: input.projectId,
        environmentId: input.environmentId,
        limit: clampLimit(input.limit),
        offset: clampOffset(input.offset),
      },
    );
    const page = paginate(payload, clampLimit(input.limit), clampOffset(input.offset));
    return renderResult({
      format: input.response_format,
      title: `${input.type} databases${input.q ? ` matching "${input.q}"` : ""} (${page.count}/${page.total})`,
      structured: page,
      isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
      empty: `No ${input.type} databases matched${input.q ? ` "${input.q}"` : ""} on this instance.`,
      markdown: (data) => {
        const rows = (data as { items: Record<string, unknown>[] }).items.map((item) => ({
          name: item.name ?? item.appName ?? "(unnamed)",
          id: item[idField(input.type)] ?? "—",
          status: item.databaseStatus ?? item.applicationStatus ?? "—",
          createdAt: humanTime(item.createdAt),
        }));
        return table(rows, [
          { key: "name", label: "Name" },
          { key: "id", label: "Id" },
          { key: "status", label: "Status" },
          { key: "createdAt", label: "Created" },
        ]);
      },
    });
  },
);

/* ----------------------------------------------------------------- get one */

const GetDatabaseSchema = z.object({ type: DatabaseTypeSchema }).passthrough();

defineTool(
  server,
  context,
  "dokploy_get_database",
  {
    title: "Get One Database Engine",
    description: `Fetch the full configuration of a single database engine instance.

Args:
  - type (enum, required): 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis' | 'libsql'
  - <type>Id (string, required): The engine-specific id (e.g. postgresId, mysqlId)

Returns: the database object

Examples:
  - Use when: you have a database id and need its full config
  - Don't use when: you only need the id -> use dokploy_search_databases

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: GetDatabaseSchema,
    annotations: READ_ONLY,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const db = await context.client.query<Record<string, unknown>>(procedure(type, "one"), {
      [idField(type)]: dbId,
    });
    const name = (db?.name as string | undefined) ?? db?.appName ?? dbId;
    return renderResult({
      format: "markdown",
      title: `${type} database "${name}"`,
      structured: { type, database: db },
      markdown: () =>
        [
          `- **Type**: ${type}`,
          `- **Id**: \`${db?.[idField(type)] ?? dbId}\``,
          `- **Name**: ${db?.name ?? "—"}`,
          `- **appName**: ${db?.appName ?? "—"}`,
          `- **Status**: ${db?.databaseStatus ?? db?.applicationStatus ?? "—"}`,
          `- **Created**: ${humanTime(db?.createdAt)}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ create */

defineTool(
  server,
  context,
  "dokploy_create_database",
  {
    title: "Create A Database Engine",
    description: `Create a new database engine instance.

The exact required fields depend on the engine (see the discriminated union
below). Postgres, mysql and mariadb require databaseName, databaseUser and
databasePassword. Mongo and redis omit databaseName. Libsql requires
every field including sqldNode and enableNamespaces.

Args: (varies by type)
  - type (enum, required): engine kind
  - name, environmentId, ... (engine-specific fields, see schema)
  - confirm (boolean, required): Must be true

Returns: the created database object

Examples:
  - Use when: "provision a postgres for the API" -> { type: "postgres", name, environmentId, databaseName, databaseUser, databasePassword, appName, confirm: true }
  - Don't use when: you need a managed RDS instance -> Dokploy creates containers

Error Handling:
  - 400 -> Dokploy zod validation failed`,
    inputSchema: DatabaseCreateSchema.and(z.object({ confirm: ConfirmSchema })),
    annotations: DESTRUCTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const refused = requireConfirmation(
      input.confirm,
      `This will create a new ${type} database engine.`,
      `Set confirm=true when you are ready to create "${input.name}"`,
    );
    if (refused) return refused;
    const db = await context.client.mutation<Record<string, unknown>>(procedure(type, "create"), {
      ...(input as unknown as Record<string, unknown>),
    });
    return renderResult({
      format: "markdown",
      title: `Created ${type} database "${input.name}"`,
      structured: { type, database: db },
      markdown: () =>
        [
          `- **Type**: ${type}`,
          `- **Id**: \`${db?.[idField(type)] ?? "—"}\``,
          `- **Name**: ${input.name}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ update */

const DatabaseMutateSchema = z.object({
  type: DatabaseTypeSchema,
  confirm: ConfirmSchema,
}).passthrough();

defineTool(
  server,
  context,
  "dokploy_update_database",
  {
    title: "Update A Database Engine",
    description: `Update configuration of an existing database engine instance.

Only the fields you pass are changed; everything else stays as-is.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - confirm (boolean, required): Must be true
  - name, appName, databaseName, ... (optional): fields to change

Returns: the updated database object

Examples:
  - Use when: "rename the postgres" -> { type: "postgres", postgresId, confirm: true, name }
  - Don't use when: you want to change the password -> use dokploy_change_database_password

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseMutateSchema,
    annotations: WRITE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const refused = requireConfirmation(
      input.confirm,
      `This will update the ${type} database engine configuration.`,
      `Set confirm=true when you are ready to update ${type} database ${dbId}`,
    );
    if (refused) return refused;
    const body: Record<string, unknown> = { [idField(type)]: dbId };
    const fields = [
      "name", "appName", "description", "databaseName", "databaseUser",
      "databasePassword", "databaseRootPassword", "dockerImage", "command",
      "args", "env", "memoryReservation", "externalPort", "memoryLimit",
      "cpuReservation", "cpuLimit", "applicationStatus", "replicaSets",
      "sqldNode", "sqldPrimaryUrl", "enableNamespaces",
    ];
    for (const key of fields) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) body[key] = value;
    }
    const db = await context.client.mutation<Record<string, unknown>>(procedure(type, "update"), body);
    return renderResult({
      format: "markdown",
      title: `Updated ${type} database ${dbId}`,
      structured: { type, database: db },
      markdown: () =>
        [
          `- **Type**: ${type}`,
          `- **Id**: \`${dbId}\``,
          `- **Name**: ${(db as Record<string, unknown>)?.name ?? "—"}`,
          `- **Status**: ${(db as Record<string, unknown>)?.databaseStatus ?? (db as Record<string, unknown>)?.applicationStatus ?? "—"}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ deploy */

defineTool(
  server,
  context,
  "dokploy_deploy_database",
  {
    title: "Deploy A Database Engine",
    description: `Trigger a fresh deployment for a database engine instance.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - confirm (boolean, required): Must be true

Returns: the deployment object

Examples:
  - Use when: "redeploy postgres after changing the config" -> { type: "postgres", postgresId, confirm: true }
  - Don't use when: the instance is already healthy -> check status first

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseMutateSchema,
    annotations: DISRUPTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const refused = requireConfirmation(
      input.confirm,
      `This will redeploy the ${type} database engine ${dbId}.`,
      `Set confirm=true when you are ready to deploy ${type} database ${dbId}`,
    );
    if (refused) return refused;
    const deployment = await context.client.mutation<Record<string, unknown>>(procedure(type, "deploy"), {
      [idField(type)]: dbId,
    });
    return renderResult({
      format: "markdown",
      title: `Deploying ${type} database ${dbId}`,
      structured: { type, deployment },
      markdown: () =>
        [
          `- **Type**: ${type}`,
          `- **Id**: \`${dbId}\``,
          `- **Status**: ${(deployment as Record<string, unknown>)?.status ?? "queued"}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ start */

defineTool(
  server,
  context,
  "dokploy_start_database",
  {
    title: "Start A Database Engine",
    description: `Start a stopped database engine instance.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "bring postgres back up" -> { type: "postgres", postgresId, confirm: true }
  - Don't use when: it's already running -> check status first

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseMutateSchema,
    annotations: DISRUPTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const refused = requireConfirmation(
      input.confirm,
      `This will start the ${type} database engine ${dbId}.`,
      `Set confirm=true when you are ready to start ${type} database ${dbId}`,
    );
    if (refused) return refused;
    await context.client.mutation(procedure(type, "start"), { [idField(type)]: dbId });
    return renderResult({
      format: "markdown",
      title: `Starting ${type} database ${dbId}`,
      structured: { type, databaseId: dbId, action: "start" },
      markdown: () => `- **Type**: ${type}\n- **Id**: \`${dbId}\`\n- **Action**: start`,
    });
  },
);

/* ------------------------------------------------------------- stop */

defineTool(
  server,
  context,
  "dokploy_stop_database",
  {
    title: "Stop A Database Engine",
    description: `Stop a running database engine instance.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "stop mysql for maintenance" -> { type: "mysql", mysqlId, confirm: true }
  - Don't use when: you want to remove it -> use dokploy_delete_database

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseMutateSchema,
    annotations: DISRUPTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const refused = requireConfirmation(
      input.confirm,
      `This will stop the ${type} database engine ${dbId}.`,
      `Set confirm=true when you are ready to stop ${type} database ${dbId}`,
    );
    if (refused) return refused;
    await context.client.mutation(procedure(type, "stop"), { [idField(type)]: dbId });
    return renderResult({
      format: "markdown",
      title: `Stopping ${type} database ${dbId}`,
      structured: { type, databaseId: dbId, action: "stop" },
      markdown: () => `- **Type**: ${type}\n- **Id**: \`${dbId}\`\n- **Action**: stop`,
    });
  },
);

/* ------------------------------------------------------------ reload */

defineTool(
  server,
  context,
  "dokploy_reload_database",
  {
    title: "Reload A Database Engine",
    description: `Redeploy a database engine instance with its current configuration.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - confirm (boolean, required): Must be true

Returns: the deployment object

Examples:
  - Use when: "apply config changes to redis" -> { type: "redis", redisId, confirm: true }
  - Don't use when: you only changed the password -> use dokploy_change_database_password

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseMutateSchema,
    annotations: DISRUPTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const refused = requireConfirmation(
      input.confirm,
      `This will redeploy the ${type} database engine ${dbId}.`,
      `Set confirm=true when you are ready to reload ${type} database ${dbId}`,
    );
    if (refused) return refused;
    const deployment = await context.client.mutation<Record<string, unknown>>(procedure(type, "reload"), {
      [idField(type)]: dbId,
    });
    return renderResult({
      format: "markdown",
      title: `Reloading ${type} database ${dbId}`,
      structured: { type, deployment },
      markdown: () =>
        [
          `- **Type**: ${type}`,
          `- **Id**: \`${dbId}\``,
          `- **Status**: ${(deployment as Record<string, unknown>)?.status ?? "queued"}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ rebuild */

defineTool(
  server,
  context,
  "dokploy_rebuild_database",
  {
    title: "Rebuild A Database Engine",
    description: `Recreate the container for a database engine. This destroys the current
container and starts a fresh one from the same image and configuration.

Data inside the container is lost unless it is on a mounted volume.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - confirm (boolean, required): Must be true

Returns: the deployment object

Examples:
  - Use when: "rebuild postgres from scratch" -> { type: "postgres", postgresId, confirm: true }
  - Don't use when: you only need a restart -> use dokploy_reload_database

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseMutateSchema,
    annotations: DESTRUCTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const refused = requireConfirmation(
      input.confirm,
      `This will permanently destroy and recreate the ${type} database container ${dbId}. Data on ephemeral storage will be lost.`,
      `Set confirm=true when you are ready to rebuild ${type} database ${dbId}`,
    );
    if (refused) return refused;
    const deployment = await context.client.mutation<Record<string, unknown>>(procedure(type, "rebuild"), {
      [idField(type)]: dbId,
    });
    return renderResult({
      format: "markdown",
      title: `Rebuilding ${type} database ${dbId}`,
      structured: { type, deployment },
      markdown: () =>
        [
          `- **Type**: ${type}`,
          `- **Id**: \`${dbId}\``,
          `- **Status**: ${(deployment as Record<string, unknown>)?.status ?? "queued"}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ delete */

defineTool(
  server,
  context,
  "dokploy_delete_database",
  {
    title: "Delete A Database Engine",
    description: `Permanently remove a database engine instance and its container.

This cannot be undone. Volumes may or may not survive depending on the engine
configuration.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "remove the old redis instance" -> { type: "redis", redisId, confirm: true }
  - Don't use when: you only want to stop it -> use dokploy_stop_database

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseMutateSchema,
    annotations: DESTRUCTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const refused = requireConfirmation(
      input.confirm,
      `This will permanently delete the ${type} database engine ${dbId} and its container.`,
      `Set confirm=true when you are ready to delete ${type} database ${dbId}`,
    );
    if (refused) return refused;
    await context.client.mutation(procedure(type, "remove"), { [idField(type)]: dbId });
    return renderResult({
      format: "markdown",
      title: `Deleted ${type} database ${dbId}`,
      structured: { type, databaseId: dbId, action: "delete" },
      markdown: () => `- **Type**: ${type}\n- **Id**: \`${dbId}\`\n- **Action**: permanently deleted`,
    });
  },
);

/* ------------------------------------------------------------ change password */

defineTool(
  server,
  context,
  "dokploy_change_database_password",
  {
    title: "Change Database Engine Password",
    description: `Change the password for a database engine user.

Not available for libsql: libsql uses \`changeStatus\` instead and has no
\`changePassword\` procedure. Calling this tool with type "libsql" returns an
immediate error.

Args:
  - type (enum, required): 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis'
  - <type>Id (string, required): The engine-specific id
  - password (string, required): New password
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "rotate the redis password" -> { type: "redis", redisId, password, confirm: true }
  - Don't use when: the engine is libsql -> this tool refuses

Error Handling:
  - libsql -> refused with a message explaining libsql has no changePassword
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseChangePasswordSchema.and(z.object({ confirm: ConfirmSchema })),
    annotations: DESTRUCTIVE,
  },
  async (input): Promise<ToolResult> => {
    // libsql is absent from DatabaseChangePasswordSchema's five branches, and the SDK
    // validates input before this handler runs, so it cannot arrive here. Two layers
    // still stand behind that: the union rejects it at validation, and if the union is
    // ever widened `libsql.changePassword` does not exist, so `procedures.ts` makes the
    // client throw rather than send a request Dokploy will 404.
    const refused = requireConfirmation(
      input.confirm,
      `This will change the password for the ${input.type} database engine.`,
      `Set confirm=true when you are ready to change the ${input.type} password`,
    );
    if (refused) return refused;

    const body: Record<string, unknown> = {
      [idField(input.type)]: (input as Record<string, unknown>)[idField(input.type)],
      password: (input as Record<string, unknown>).password,
    };
    if (input.type === "mysql") {
      body.passwordType = (input as Record<string, unknown>).passwordType ?? "user";
    }

    await context.client.mutation(procedure(input.type, "changePassword"), body);
    return renderResult({
      format: "markdown",
      title: `Password changed for ${input.type} database ${(input as Record<string, unknown>)[idField(input.type)] as string}`,
      structured: { type: input.type, databaseId: (input as Record<string, unknown>)[idField(input.type)] as string, action: "changePassword" },
      markdown: () =>
        `- **Type**: ${input.type}\n- **Id**: \`${(input as Record<string, unknown>)[idField(input.type)] as string}\`\n- **Action**: password changed`,
    });
  },
);

/* ------------------------------------------------------------ logs */

const DatabaseLogsSchema = z
  .object({
    type: DatabaseTypeSchema,
    ...LogTailSchema,
  })
  .strict();

defineTool(
  server,
  context,
  "dokploy_get_database_logs",
  {
    title: "Get Database Engine Logs",
    description: `Return the most recent log lines for a database engine instance.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - tail (number, optional): 1-10000, default 200
  - search (string, optional): Only return lines containing this substring

Returns:
  { "logs": [ "line 1", "line 2", … ], "databaseId": "abc123…", "type": "postgres" }

Examples:
  - Use when: "postgres is crashing, show me the last 100 lines" -> { type: "postgres", postgresId, tail: 100 }
  - Don't use when: you need compose logs -> use dokploy_get_compose_logs

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: DatabaseLogsSchema,
    annotations: READ_ONLY,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const logs = await context.client.query<string[]>(
      procedure(type, "readLogs"),
      {
        [idField(type)]: dbId,
        tail: input.tail,
        since: undefined,
        search: input.search ?? undefined,
      },
      { timeoutMs: LOG_TIMEOUT_MS },
    );
    const logLines = Array.isArray(logs) ? logs : [];
    return renderResult({
      format: "markdown",
      title: `${type} logs for ${dbId} (${logLines.length} lines)`,
      structured: { type, databaseId: dbId, logs: logLines },
      isEmpty: (data) => (data as { logs: unknown[] }).logs.length === 0,
      empty: "No log lines matched.",
      markdown: () => {
        const lines = logLines;
        return lines.length === 0
          ? "_no log lines_"
          : "```\n" + lines.join("\n") + "\n```";
      },
    });
  },
);

/* ------------------------------------------------------------ external port */

const SetDatabaseExternalPortSchema = DatabaseExternalPortSchema.and(z.object({ confirm: ConfirmSchema }));

defineTool(
  server,
  context,
  "dokploy_set_database_external_port",
  {
    title: "Set Database Engine External Port",
    description: `Set or clear the external port for a database engine.

Dokploy exposes this under two different procedure names depending on the
engine: \`saveExternalPort\` for postgres, mysql, mariadb, mongo and redis;
\`saveExternalPorts\` (plural) for libsql. This inconsistency is real and
verified against the v0.30.8 spec.

Changing the external port restarts the engine.

Args:
  - type (enum, required): engine kind
  - <type>Id (string, required): The engine-specific id
  - externalPort (number | null, required): Port number, or null to clear
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "expose postgres on port 5433" -> { type: "postgres", postgresId, externalPort: 5433, confirm: true }
  - Use when: "remove the external port mapping" -> { type: "redis", redisId, externalPort: null, confirm: true }
  - Don't use when: the engine is already down -> start it first so the port change takes effect

Error Handling:
  - 404 -> wrong <type>Id`,
    inputSchema: SetDatabaseExternalPortSchema,
    annotations: DESTRUCTIVE,
  },
  async (input): Promise<ToolResult> => {
    const type = input.type;
    const dbId = requireDatabaseId(type, input as Record<string, unknown>);
    const verb = EXTERNAL_PORT_VERB[type];
    const refused = requireConfirmation(
      input.confirm,
      `This will change the external port for the ${type} database engine ${dbId} and restart it.`,
      `Set confirm=true when you are ready to set the external port for ${type} database ${dbId}`,
    );
    if (refused) return refused;

    const body: Record<string, unknown> = {
      [idField(type)]: dbId,
      externalPort: (input as Record<string, unknown>).externalPort,
    };

    await context.client.mutation(procedure(type, verb), body);
    return renderResult({
      format: "markdown",
      title: `External port updated for ${type} database ${dbId}`,
      structured: { type, databaseId: dbId, externalPort: (input as Record<string, unknown>).externalPort, action: verb },
      markdown: () =>
        `- **Type**: ${type}\n- **Id**: \`${dbId}\`\n- **externalPort**: ${(input as Record<string, unknown>).externalPort ?? "cleared"}\n- **Action**: ${verb}`,
    });
  },
);
}
