/**
 * Compose stack tools.
 *
 * Compose stacks let a manager run multi-container applications defined by a
 * docker-compose file. These tools cover the full lifecycle: search, inspect,
 * create, update, deploy, start, stop, redeploy, delete, environment management,
 * log retrieval and service inspection.
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
import type { ComposeSummary, Paginated } from "../types.js";
import {
  AppNameSchema,
  IdSchema,
  PaginationSchema,
  ResponseFormatSchema,
  LogTailSchema,
  ConfirmSchema,
} from "../schemas/common.js";
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

const COMPOSE_TYPE_ENUM = ["docker-compose", "stack"] as const;
const ComposeTypeSchema = z.enum(COMPOSE_TYPE_ENUM);

const ComposeSearchSchema = z
  .object({
    q: z.string().optional().describe("Free-text match against name and description"),
    name: z.string().optional().describe("Match the compose name"),
    appName: z.string().optional().describe("Match the appName"),
    description: z.string().optional().describe("Match the description"),
    projectId: z.string().optional().describe("Narrow to this project id"),
    environmentId: z.string().optional().describe("Narrow to this environment id"),
    ...PaginationSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

/* ----------------------------------------------------------------- search */

export function registerCompose(server: McpServer, context: ToolContext): void {

defineTool(
  server,
  context,
  "dokploy_search_composes",
  {
    title: "Search Compose Stacks",
    description: `Search compose stacks by name, appName or description, with pagination.

Use this to discover what stacks exist before deploying, starting or deleting them.

Args:
  - q (string, optional): Free-text match against name and description
  - name (string, optional): Match the compose name specifically
  - appName (string, optional): Match the appName
  - description (string, optional): Match the description
  - projectId (string, optional): Narrow to this project id
  - environmentId (string, optional): Narrow to this environment id
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "total": 3, "count": 3, "offset": 0, "items": [...], "has_more": false }

Examples:
  - Use when: "find the monitoring stack" -> { q: "monitoring" }
  - Use when: you have an environmentId and want its stacks -> { environmentId: "3dFId8fY7…" }
  - Don't use when: you already hold the composeId -> use dokploy_get_compose

Error Handling:
  - No match -> returns has_more false with an empty items array`,
    inputSchema: ComposeSearchSchema,
    annotations: READ_ONLY,
  },
  async (input): Promise<ToolResult> => {
    const payload = await context.client.query<Paginated<ComposeSummary> | ComposeSummary[]>(
      "compose.search",
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
      title: `Compose stacks${input.q ? ` matching "${input.q}"` : ""} (${page.count}/${page.total})`,
      structured: page,
      isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
      empty: `No compose stacks matched${input.q ? ` "${input.q}"` : ""} on this instance.`,
      markdown: (data) => {
        const rows = (data as { items: ComposeSummary[] }).items.map((item) => ({
          name: item.name ?? item.appName ?? "(unnamed)",
          composeId: item.composeId,
          status: item.composeStatus ?? "—",
          source: item.sourceType ?? "—",
          createdAt: humanTime(item.createdAt),
        }));
        return table(rows, [
          { key: "name", label: "Name" },
          { key: "composeId", label: "composeId" },
          { key: "status", label: "Status" },
          { key: "source", label: "Source" },
          { key: "createdAt", label: "Created" },
        ]);
      },
    });
  },
);

/* ----------------------------------------------------------------- get one */

const GetComposeSchema = z.object({ composeId: IdSchema }).strict();

defineTool(
  server,
  context,
  "dokploy_get_compose",
  {
    title: "Get One Compose Stack",
    description: `Fetch the full configuration of a single compose stack.

Args:
  - composeId (string, required): The compose stack id

Returns: the compose object including its compose file, environment and deployment config

Examples:
  - Use when: you have a composeId and need its full config before editing
  - Don't use when: you only need the id -> use dokploy_search_composes

Error Handling:
  - 404 -> no compose stack with that id on this instance`,
    inputSchema: GetComposeSchema,
    annotations: READ_ONLY,
  },
  async ({ composeId }): Promise<ToolResult> => {
    const compose = await context.client.query<Record<string, unknown>>("compose.one", { composeId });
    const name = (compose?.name as string | undefined) ?? compose?.appName ?? composeId;
    return renderResult({
      format: "markdown",
      title: `Compose "${name}"`,
      structured: { compose },
      markdown: () =>
        [
          `- **composeId**: ${compose?.composeId ?? composeId}`,
          `- **Name**: ${compose?.name ?? "—"}`,
          `- **appName**: ${compose?.appName ?? "—"}`,
          `- **Type**: ${compose?.composeType ?? "—"}`,
          `- **Status**: ${compose?.composeStatus ?? "—"}`,
          `- **Source**: ${compose?.sourceType ?? "—"}`,
          `- **Description**: ${compose?.description || "—"}`,
          `- **Created**: ${humanTime(compose?.createdAt)}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ create */

const CreateComposeSchema = z
  .object({
    name: z.string().min(1).describe("Service name"),
    environmentId: z.string().describe("The environment id"),
    appName: AppNameSchema,
    composeType: ComposeTypeSchema.describe("Stack type: docker-compose or swarm stack"),
    description: z.string().nullable().optional().describe("Human description, or null"),
    composeFile: z.string().optional().describe("Raw docker-compose YAML"),
    serverId: z.string().nullable().optional().describe("Server id, or null for the default host"),
    confirm: ConfirmSchema,
  })
  .strict();

defineTool(
  server,
  context,
  "dokploy_create_compose",
  {
    title: "Create A Compose Stack",
    description: `Create a new compose stack in the specified environment.

Args:
  - name (string, required): Service name
  - environmentId (string, required): The environment id
  - appName (string, required): Container/app identifier (1-63 chars of [a-zA-Z0-9._-])
  - composeType (enum, required): 'docker-compose' | 'stack'
  - description (string, optional): Human description, or null
  - composeFile (string, optional): Raw docker-compose YAML to seed the stack
  - serverId (string, optional): Server id, or null for the default host
  - confirm (boolean, required): Must be true

Returns: the created compose object

Examples:
  - Use when: "create a new monitoring stack" -> provide name, environmentId, appName, composeType
  - Use when: you have a compose file ready -> also pass composeFile
  - Don't use when: you need to import from git -> use a different workflow

Error Handling:
  - 400 -> Dokploy zod validation failed (check appName pattern, required fields)`,
    inputSchema: CreateComposeSchema,
    annotations: DESTRUCTIVE,
  },
  async (input): Promise<ToolResult> => {
    const refused = requireConfirmation(input.confirm, "This will create a new compose stack", `Set confirm=true when you are ready to create "${input.name}"`);
    if (refused) return refused;
    const compose = await context.client.mutation<Record<string, unknown>>("compose.create", {
      name: input.name,
      appName: input.appName,
      environmentId: input.environmentId,
      composeType: input.composeType,
      description: input.description ?? null,
      composeFile: input.composeFile ?? null,
      serverId: input.serverId ?? null,
    });
    return renderResult({
      format: "markdown",
      title: `Created compose "${input.name}"`,
      structured: { compose },
      markdown: () =>
        [
          `- **composeId**: ${(compose as Record<string, unknown>)?.composeId ?? "—"}`,
          `- **Name**: ${input.name}`,
          `- **appName**: ${input.appName}`,
          `- **Type**: ${input.composeType}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ update */

const UpdateComposeSchema = z
  .object({
    composeId: IdSchema,
    confirm: ConfirmSchema,
    name: z.string().min(1).optional().describe("Service name"),
    appName: AppNameSchema.optional(),
    description: z.string().nullable().optional().describe("Human description, or null"),
    env: z.string().nullable().optional().describe("Environment variables as JSON string"),
    composeFile: z.string().optional().describe("Raw docker-compose YAML"),
    refreshToken: z.string().nullable().optional().describe("Git refresh token"),
    sourceType: z.enum(["git", "github", "gitlab", "bitbucket", "gitea", "raw"]).optional(),
    composeType: ComposeTypeSchema.optional(),
    repository: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    autoDeploy: z.boolean().optional(),
    gitlabProjectId: z.number().nullable().optional(),
    gitlabRepository: z.string().nullable().optional(),
    gitlabOwner: z.string().nullable().optional(),
    gitlabBranch: z.string().nullable().optional(),
    gitlabPathNamespace: z.string().nullable().optional(),
    bitbucketRepository: z.string().nullable().optional(),
    bitbucketRepositorySlug: z.string().nullable().optional(),
    bitbucketOwner: z.string().nullable().optional(),
    bitbucketBranch: z.string().nullable().optional(),
    giteaRepository: z.string().nullable().optional(),
    giteaOwner: z.string().nullable().optional(),
    giteaBranch: z.string().nullable().optional(),
    customGitUrl: z.string().nullable().optional(),
    customGitBranch: z.string().nullable().optional(),
    customGitSSHKeyId: z.string().nullable().optional(),
    command: z.string().optional(),
    enableSubmodules: z.boolean().optional(),
    composePath: z.string().min(1).optional().describe("Path to compose file in repo"),
    suffix: z.string().optional(),
    randomize: z.boolean().optional(),
    isolatedDeployment: z.boolean().optional(),
    isolatedDeploymentsVolume: z.boolean().optional(),
    triggerType: z.enum(["push", "tag"]).nullable().optional(),
  })
  .strict();

defineTool(
  server,
  context,
  "dokploy_update_compose",
  {
    title: "Update A Compose Stack",
    description: `Update configuration of an existing compose stack.

Only the fields you pass are changed; everything else stays as-is.

Args:
  - composeId (string, required): The compose stack id
  - confirm (boolean, required): Must be true
  - name (string, optional): Service name
  - appName (string, optional): Container/app identifier
  - description (string, optional): Human description, or null
  - env (string, optional): Environment variables as JSON string
  - composeFile (string, optional): Raw docker-compose YAML
  - composeType (enum, optional): 'docker-compose' | 'stack'
  - sourceType (enum, optional): git | github | gitlab | bitbucket | gitea | raw
  - repository (string, optional): Git repository url
  - branch (string, optional): Git branch
  - composePath (string, optional): Path to compose file in repo
  - ... (additional git and deployment fields)

Returns: the updated compose object

Examples:
  - Use when: "rename the stack" -> { composeId, confirm: true, name }
  - Use when: "switch to git source" -> { composeId, confirm: true, sourceType: "github", repository, owner, branch }
  - Don't use when: you want to redeploy -> use dokploy_reload_compose

Error Handling:
  - 404 -> wrong composeId
  - 400 -> Dokploy zod validation failed`,
    inputSchema: UpdateComposeSchema,
    annotations: WRITE,
  },
  async (input): Promise<ToolResult> => {
    const refused = requireConfirmation(input.confirm, "This will update the compose stack configuration", `Set confirm=true when you are ready to update compose ${input.composeId}`);
    if (refused) return refused;
    const body: Record<string, unknown> = { composeId: input.composeId };
    const fields = [
      "name", "appName", "description", "env", "composeFile", "refreshToken",
      "sourceType", "composeType", "repository", "owner", "branch", "autoDeploy",
      "gitlabProjectId", "gitlabRepository", "gitlabOwner", "gitlabBranch",
      "gitlabPathNamespace", "bitbucketRepository", "bitbucketRepositorySlug",
      "bitbucketOwner", "bitbucketBranch", "giteaRepository", "giteaOwner",
      "giteaBranch", "customGitUrl", "customGitBranch", "customGitSSHKeyId",
      "command", "enableSubmodules", "composePath", "suffix", "randomize",
      "isolatedDeployment", "isolatedDeploymentsVolume", "triggerType",
    ];
    for (const key of fields) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) body[key] = value;
    }
    const compose = await context.client.mutation<Record<string, unknown>>("compose.update", body);
    return renderResult({
      format: "markdown",
      title: `Updated compose ${input.composeId}`,
      structured: { compose },
      markdown: () =>
        [
          `- **composeId**: ${input.composeId}`,
          `- **Name**: ${(compose as Record<string, unknown>)?.name ?? "—"}`,
          `- **Status**: ${(compose as Record<string, unknown>)?.composeStatus ?? "—"}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ deploy */

const DeployComposeSchema = z
  .object({
    composeId: IdSchema,
    confirm: ConfirmSchema,
    title: z.string().optional().describe("Deployment title"),
    description: z.string().optional().describe("Deployment description"),
  })
  .strict();

defineTool(
  server,
  context,
  "dokploy_deploy_compose",
  {
    title: "Deploy A Compose Stack",
    description: `Trigger a new deployment for the compose stack.

Args:
  - composeId (string, required): The compose stack id
  - confirm (boolean, required): Must be true
  - title (string, optional): Deployment title for the audit log
  - description (string, optional): Deployment description

Returns: the deployment object

Examples:
  - Use when: "redeploy the stack after a config change" -> { composeId, confirm: true }
  - Use when: "deploy the latest git commit" -> provide title for traceability
  - Don't use when: the stack is already up-to-date -> check status first

Error Handling:
  - 404 -> wrong composeId
  - 400 -> the compose file is invalid`,
    inputSchema: DeployComposeSchema,
    annotations: DISRUPTIVE,
  },
  async (input): Promise<ToolResult> => {
    const refused = requireConfirmation(input.confirm, "This will redeploy the compose stack", `Set confirm=true when you are ready to deploy compose ${input.composeId}`);
    if (refused) return refused;
    const deployment = await context.client.mutation<Record<string, unknown>>("compose.deploy", {
      composeId: input.composeId,
      title: input.title ?? null,
      description: input.description ?? null,
    });
    return renderResult({
      format: "markdown",
      title: `Deploying compose ${input.composeId}`,
      structured: { deployment },
      markdown: () =>
        [
          `- **Deployment**: ${(deployment as Record<string, unknown>)?.deploymentId ?? "—"}`,
          `- **Status**: ${(deployment as Record<string, unknown>)?.status ?? "queued"}`,
          `- **Title**: ${input.title ?? "—"}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ start */

const StartComposeSchema = z.object({ composeId: IdSchema, confirm: ConfirmSchema }).strict();

defineTool(
  server,
  context,
  "dokploy_start_compose",
  {
    title: "Start A Compose Stack",
    description: `Start a stopped compose stack.

Args:
  - composeId (string, required): The compose stack id
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "bring the stack back up after maintenance" -> { composeId, confirm: true }
  - Don't use when: the stack is already running -> check composeStatus first

Error Handling:
  - 404 -> wrong composeId`,
    inputSchema: StartComposeSchema,
    annotations: DISRUPTIVE,
  },
  async ({ composeId, confirm }): Promise<ToolResult> => {
    const refused = requireConfirmation(confirm, "This will start the compose stack and all its containers", `Set confirm=true when you are ready to start compose ${composeId}`);
    if (refused) return refused;
    await context.client.mutation("compose.start", { composeId });
    return renderResult({
      format: "markdown",
      title: `Starting compose ${composeId}`,
      structured: { composeId, action: "start" },
      markdown: () => `- **composeId**: ${composeId}\n- **Action**: start`,
    });
  },
);

/* ------------------------------------------------------------- stop */

defineTool(
  server,
  context,
  "dokploy_stop_compose",
  {
    title: "Stop A Compose Stack",
    description: `Stop a running compose stack. Containers are halted but not removed.

Args:
  - composeId (string, required): The compose stack id
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "stop the stack for maintenance" -> { composeId, confirm: true }
  - Don't use when: you want to remove the stack -> use dokploy_delete_compose

Error Handling:
  - 404 -> wrong composeId`,
    inputSchema: z.object({ composeId: IdSchema, confirm: ConfirmSchema }).strict(),
    annotations: DISRUPTIVE,
  },
  async ({ composeId, confirm }): Promise<ToolResult> => {
    const refused = requireConfirmation(confirm, "This will stop the compose stack and halt all its containers", `Set confirm=true when you are ready to stop compose ${composeId}`);
    if (refused) return refused;
    await context.client.mutation("compose.stop", { composeId });
    return renderResult({
      format: "markdown",
      title: `Stopping compose ${composeId}`,
      structured: { composeId, action: "stop" },
      markdown: () => `- **composeId**: ${composeId}\n- **Action**: stop`,
    });
  },
);

/* ------------------------------------------------------------ reload */

defineTool(
  server,
  context,
  "dokploy_reload_compose",
  {
    title: "Reload (Redeploy) A Compose Stack",
    description: `Redeploy the compose stack with the same source. Equivalent to a fresh deploy.

Args:
  - composeId (string, required): The compose stack id
  - title (string, optional): Deployment title for the audit log
  - description (string, optional): Deployment description
  - confirm (boolean, required): Must be true

Returns: the deployment object

Examples:
  - Use when: "redeploy after editing the compose file" -> { composeId, confirm: true }
  - Don't use when: you only want to pull the latest image -> use dokploy_deploy_compose without changing source

Error Handling:
  - 404 -> wrong composeId`,
    inputSchema: z.object({ composeId: IdSchema, title: z.string().optional(), description: z.string().optional(), confirm: ConfirmSchema }).strict(),
    annotations: DISRUPTIVE,
  },
  async ({ composeId, title, description, confirm }): Promise<ToolResult> => {
    const refused = requireConfirmation(confirm, "This will redeploy the compose stack", `Set confirm=true when you are ready to reload compose ${composeId}`);
    if (refused) return refused;
    const deployment = await context.client.mutation<Record<string, unknown>>("compose.redeploy", {
      composeId,
      title: title ?? null,
      description: description ?? null,
    });
    return renderResult({
      format: "markdown",
      title: `Reloading compose ${composeId}`,
      structured: { deployment },
      markdown: () =>
        [
          `- **Deployment**: ${(deployment as Record<string, unknown>)?.deploymentId ?? "—"}`,
          `- **Status**: ${(deployment as Record<string, unknown>)?.status ?? "queued"}`,
        ].join("\n"),
    });
  },
);

/* ------------------------------------------------------------ delete */

defineTool(
  server,
  context,
  "dokploy_delete_compose",
  {
    title: "Delete A Compose Stack",
    description: `Permanently remove a compose stack and all its containers, networks and volumes.

This cannot be undone.

Args:
  - composeId (string, required): The compose stack id
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "remove the old monitoring stack" -> { composeId, confirm: true }
  - Don't use when: you want to keep the stack but stop it -> use dokploy_stop_compose

Error Handling:
  - 404 -> wrong composeId`,
    inputSchema: z.object({ composeId: IdSchema, confirm: ConfirmSchema }).strict(),
    annotations: DESTRUCTIVE,
  },
  async ({ composeId, confirm }): Promise<ToolResult> => {
    const refused = requireConfirmation(confirm, `This will permanently delete compose stack ${composeId} and all its containers, networks and volumes.`, `Set confirm=true when you are ready to delete compose ${composeId}`);
    if (refused) return refused;
    await context.client.mutation("compose.delete", { composeId });
    return renderResult({
      format: "markdown",
      title: `Deleted compose ${composeId}`,
      structured: { composeId, action: "delete" },
      markdown: () => `- **composeId**: ${composeId}\n- **Action**: permanently deleted`,
    });
  },
);

/* ------------------------------------------------------------ set env */

defineTool(
  server,
  context,
  "dokploy_set_compose_env",
  {
    title: "Set Compose Environment Variables",
    description: `Replace the entire environment-variable block for a compose stack.

Dokploy stores these as a single env-string (dotenv-style). Passing this tool the
new value overwrites everything that was there before.

Args:
  - composeId (string, required): The compose stack id
  - env (string, required): New environment variables in dotenv format
  - confirm (boolean, required): Must be true

Returns: acknowledgement payload

Examples:
  - Use when: "update the DATABASE_URL for the stack" -> provide the full env block
  - Don't use when: you only want to change one variable -> include the entire current env plus the change

Error Handling:
  - 404 -> wrong composeId`,
    inputSchema: z.object({ composeId: IdSchema, env: z.string().min(1).describe("New environment variables in dotenv format"), confirm: ConfirmSchema }).strict(),
    annotations: DESTRUCTIVE,
  },
  async ({ composeId, env, confirm }): Promise<ToolResult> => {
    const refused = requireConfirmation(confirm, `This will overwrite all environment variables for compose ${composeId}.`, `Set confirm=true when you are ready to set the env for compose ${composeId}`);
    if (refused) return refused;
    await context.client.mutation("compose.saveEnvironment", { composeId, env });
    return renderResult({
      format: "markdown",
      title: `Environment updated for compose ${composeId}`,
      structured: { composeId, action: "saveEnvironment" },
      markdown: () => `- **composeId**: ${composeId}\n- **Action**: environment variables replaced`,
    });
  },
);

/* ------------------------------------------------------------ services */

defineTool(
  server,
  context,
  "dokploy_get_compose_services",
  {
    title: "List Compose Services",
    description: `List the services defined inside a compose stack.

This is what dokploy_get_compose_logs uses internally to find a container id. It is
exposed here so an agent can see which services exist, their image and status.

Args:
  - composeId (string, required): The compose stack id
  - type (string, optional): Filter by service type

Returns: array of service summaries

Examples:
  - Use when: "what services does the stack have?" -> { composeId }
  - Use when: you need a containerId for logs -> inspect the result for the container field
  - Don't use when: you only want the stack's top-level config -> use dokploy_get_compose

Error Handling:
  - 404 -> wrong composeId`,
    inputSchema: z
      .object({
        composeId: IdSchema,
        type: z.string().optional().describe("Filter by service type"),
      })
      .strict(),
    annotations: READ_ONLY,
  },
  async ({ composeId, type }): Promise<ToolResult> => {
    const services = await context.client.query<Array<Record<string, unknown>>>("compose.loadServices", {
      composeId,
      ...(type ? { type } : {}),
    });
    const rows = (Array.isArray(services) ? services : []).map((svc) => ({
      serviceName: (svc.serviceName as string | undefined) ?? "—",
      image: (svc.image as string | undefined) ?? "—",
      state: (svc.state as string | undefined) ?? (svc.Status as string | undefined) ?? "—",
      status: (svc.status as string | undefined) ?? "—",
      containerId: (svc.container as Record<string, unknown> | undefined)?.Id as string | undefined ?? "—",
    }));
    return renderResult({
      format: "markdown",
      title: `Services in compose ${composeId} (${rows.length})`,
      structured: { composeId, services: rows },
      isEmpty: (data) => (data as { services: unknown[] }).services.length === 0,
      empty: `Compose ${composeId} has no services.`,
      markdown: () =>
        table(rows, [
          { key: "serviceName", label: "Service" },
          { key: "image", label: "Image" },
          { key: "state", label: "State" },
          { key: "status", label: "Status" },
          { key: "containerId", label: "containerId" },
        ]),
    });
  },
);

/* ------------------------------------------------------------ logs */

const ComposeLogsSchema = z
  .object({
    composeId: IdSchema,
    ...LogTailSchema,
  })
  .strict();

defineTool(
  server,
  context,
  "dokploy_get_compose_logs",
  {
    title: "Get Compose Stack Logs",
    description: `Return the most recent log lines for a compose stack.

containerId is resolved internally from dokploy_get_compose_services. If no
container is found, the tool returns a clear error telling you to start the
service first.

Args:
  - composeId (string, required): The compose stack id
  - tail (number, optional): 1-10000, default 200
  - search (string, optional): Only return lines containing this substring

Returns:
  { "logs": [ "line 1", "line 2", … ], "containerId": "abc123…" }

Examples:
  - Use when: "why is the stack failing?" -> { composeId }
  - Use when: logs are huge -> lower tail to 50
  - Don't use when: you need per-service logs -> use dokploy_get_compose_services to find the container id, then this tool

Error Handling:
  - No container -> tells you to start the service first
  - 404 -> wrong composeId`,
    inputSchema: ComposeLogsSchema,
    annotations: READ_ONLY,
  },
  async (input): Promise<ToolResult> => {
    const services = await context.client.query<Array<Record<string, unknown>>>("compose.loadServices", {
      composeId: input.composeId,
    });

    let containerId: string | undefined;
    const serviceArray = Array.isArray(services) ? services : [];
    for (const svc of serviceArray) {
      const container = svc.container as Record<string, unknown> | undefined;
      const id = container?.Id as string | undefined;
      if (id && id.length > 0) {
        containerId = id;
        break;
      }
    }

    if (!containerId) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `No running container found for compose ${input.composeId}. ` +
              `The stack has ${serviceArray.length} service(s) but none reports a container. ` +
              `Start the stack first with dokploy_start_compose, then retry this tool.`,
          },
        ],
      };
    }

    const logs = await context.client.query<string[]>(
      "compose.readLogs",
      {
        composeId: input.composeId,
        containerId,
        tail: input.tail,
        since: undefined,
        search: input.search ?? undefined,
      },
      { timeoutMs: LOG_TIMEOUT_MS },
    );

    const logLines = Array.isArray(logs) ? logs : [];
    return renderResult({
      format: "markdown",
      title: `Logs for compose ${input.composeId} (${logLines.length} lines)`,
      structured: { composeId: input.composeId, containerId, logs: logLines },
      isEmpty: (data) => (data as { logs: unknown[] }).logs.length === 0,
      empty: `No log lines matched.`,
      markdown: (data) => {
        const lines = (data as { logs: string[] }).logs;
        return lines.length === 0
          ? "_no log lines_"
          : "```\n" + lines.join("\n") + "\n```";
      },
    });
  },
);
}
