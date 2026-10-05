/**
 * Discovery and context tools.
 *
 * These answer "what is on this instance?" and are what an agent should call before any
 * mutation, so that it knows which projects, environments and servers actually exist.
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
import type {
  Paginated,
  Project,
  ProjectSummary,
  ServerSummary,
  SessionInfo,
} from "../types.js";
import { PaginationSchema, ResponseFormatSchema } from "../schemas/common.js";
import { defineTool, READ_ONLY, type ToolContext, type ToolResult } from "./registry.js";

/**
 * `project.all` keys its per-environment service arrays in the plural
 * (`applications`, `compose`, `postgres`, …). Trim the plural for display rather than
 * slicing the last character, which turns `compose` into `compos`.
 */
function singular(plural: string): string {
  if (plural.endsWith("ies")) return `${plural.slice(0, -3)}y`;
  if (plural.endsWith("ses")) return plural.slice(0, -2);
  if (plural.endsWith("s")) return plural.slice(0, -1);
  return plural;
}

export function registerDiscovery(server: McpServer, context: ToolContext): void {
  /* ------------------------------------------------------------- whoami */

  defineTool(
    server,
    context,
    "dokploy_whoami",
    {
      title: "Identify the Dokploy Session",
      description: `Confirm the API key works and report which identity and organization it acts as.

Every other tool in this server is scoped to whatever this key can reach, so call this first
when you are unsure which instance or tenant you are talking to.

Args: none

Returns:
  { "userId": "BeEtaZAXp…", "organizationId": "QWuZWiwm…", "dokployUrl": "https://…" }

Examples:
  - Use when: starting a session, to confirm connectivity before planning work
  - Use when: an id-scoped call returns 404 and you suspect the wrong instance

Error Handling:
  - 401 -> the key is invalid or DOKPLOY_URL points at the wrong instance`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const session = await context.client.query<SessionInfo>("user.session");
      const structured = {
        userId: session.user?.id ?? null,
        organizationId: session.session?.activeOrganizationId ?? null,
        dokployUrl: context.config.dokployUrl,
      };
      return renderResult({
        format: "markdown",
        title: "Dokploy Session",
        structured,
        markdown: () =>
          [
            `- **Instance**: ${structured.dokployUrl}`,
            `- **User id**: ${structured.userId ?? "unknown"}`,
            `- **Active organization**: ${structured.organizationId ?? "unknown"}`,
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------------- health */

  defineTool(
    server,
    context,
    "dokploy_check_health",
    {
      title: "Check Dokploy Instance Health",
      description: `Report whether the Dokploy control plane is healthy, along with its version.

Call this before a long operation to confirm the instance is up, or when a deployment fails
for no apparent reason.

Args: none

Returns:
  { "status": "ok", "version": "v0.30.8", "reachable": true }

Examples:
  - Use when: "is the Dokploy server up?" -> this is the fastest check
  - Use when: diagnosing an intermittent deploy failure

Error Handling:
  - Network error -> the instance is unreachable; check DOKPLOY_URL
  - The \`version\` field is the Dokploy release, not this MCP server's version`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const { status, version } = await context.client.probe();
      const structured = { status, version, reachable: true };
      return renderResult({
        format: "markdown",
        title: "Dokploy Health",
        structured,
        markdown: () =>
          [
            `- **Status**: ${structured.status}`,
            `- **Dokploy version**: ${structured.version}`,
            `- **Reachable**: yes`,
          ].join("\n"),
      });
    },
  );

  /* ----------------------------------------------------------- projects */

  defineTool(
    server,
    context,
    "dokploy_list_projects",
    {
      title: "List Dokploy Projects With Their Services",
      description: `List every project with its environments and the services inside each one.

This is the most information-dense read in the API and the best starting point: the response
already contains every service id, which is what almost every other tool requires. Projects
nest environments, which in turn nest applications, compose stacks and the six database
engines — so one call answers "what exists on this instance?".

Args: none

Returns:
  { "projects": [ { "projectId": "TWo48hMYi…", "name": "AI Router",
                    "environments": [ { "environmentId": "3dFId8fY7…", "name": "production",
                                        "isDefault": true,
                                        "applications": [...], "compose": [...] } ] } ] }

Examples:
  - Use when: "what projects are here?" -> call this, then use the ids it returns
  - Use when: "which environment should I deploy to?" -> read the \`isDefault\` flag
  - Don't use when: you need only service names -> use dokploy_search_projects

Error Handling:
  - 401/403 -> the key cannot see any project`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const projects = await context.client.query<Project[]>("project.all");
      const rows = (projects ?? []).map((project) => {
        const environments = project.environments ?? [];
        const counts = environments.reduce<Record<string, number>>((acc, env) => {
          for (const key of [
            "applications",
            "compose",
            "postgres",
            "mysql",
            "mariadb",
            "mongo",
            "redis",
            "libsql",
          ] as const) {
            const n = env[key]?.length ?? 0;
            if (n > 0) acc[key] = (acc[key] ?? 0) + n;
          }
          return acc;
        }, {});
        return {
          projectId: project.projectId,
          name: project.name ?? "(unnamed)",
          environments: environments.length,
          defaultEnvironment:
            environments.find((env) => env.isDefault)?.name ??
            environments[0]?.name ??
            "—",
            services: Object.entries(counts)
              .map(([key, n]) => `${singular(key)}:${n}`)
              .join(", "),
          createdAt: humanTime(project.createdAt),
        };
      });

      const structured = { projects };
      return renderResult({
        format: "markdown",
        title: `Projects (${rows.length})`,
        structured,
        isEmpty: (data) => ((data as { projects: unknown[] }).projects ?? []).length === 0,
        empty: "No projects are visible to this API key.",
        markdown: () =>
          table(rows, [
            { key: "name", label: "Project" },
            { key: "projectId", label: "projectId" },
            { key: "environments", label: "Envs" },
            { key: "defaultEnvironment", label: "Default env" },
            { key: "services", label: "Services" },
            { key: "createdAt", label: "Created" },
          ]),
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_get_project",
    {
      title: "Get One Dokploy Project",
      description: `Fetch a single project's full configuration.

Args:
  - projectId (string, required): The project id

Returns: the project object, including its environments and their services

Examples:
  - Use when: you already hold a projectId and want its environments
  - Don't use when: you only have a project name -> use dokploy_resolve_service or
    dokploy_list_projects to find the id first

Error Handling:
  - 404 -> no project with that id on this instance`,
      inputSchema: z
        .object({
          projectId: z.string().min(1).describe("The project id"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ projectId }): Promise<ToolResult> => {
      const project = await context.client.query<Project>("project.one", { projectId });
      const structured = { project };
      return renderResult({
        format: "markdown",
        title: `Project ${project?.name ?? projectId}`,
        structured,
        markdown: () =>
          [
            `- **projectId**: ${project?.projectId ?? projectId}`,
            `- **Name**: ${project?.name ?? "—"}`,
            `- **Description**: ${project?.description || "—"}`,
            `- **Created**: ${humanTime(project?.createdAt)}`,
            `- **Environments**: ${(project?.environments ?? []).length}`,
          ].join("\n"),
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_search_projects",
    {
      title: "Search Dokploy Projects",
      description: `Search projects by name or description, with pagination.

Args:
  - q (string, optional): Free-text match against name and description
  - name (string, optional): Match the project name specifically
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "total": 2, "count": 2, "offset": 0, "items": [...], "has_more": false }

Examples:
  - Use when: "find the AI project" -> { q: "AI" }
  - Don't use when: you want the services inside a project -> use dokploy_list_projects

Error Handling:
  - No match -> returns has_more false with an empty items array`,
      inputSchema: z
        .object({
          q: z.string().optional().describe("Free-text match against name and description"),
          name: z.string().optional().describe("Match the project name"),
          ...PaginationSchema,
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ q, name, limit, offset, response_format }): Promise<ToolResult> => {
      const payload = await context.client.query<Paginated<ProjectSummary>>("project.search", {
        q,
        name,
        limit: clampLimit(limit),
        offset: clampOffset(offset),
      });
      const page = paginate(payload, clampLimit(limit), clampOffset(offset));
      return renderResult({
        format: response_format,
        title: `Projects matching ${q ?? name ?? "*"} (${page.count}/${page.total})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `No projects matched ${JSON.stringify(q ?? name ?? "*")}.`,
        markdown: (data) => {
          const rows = (data as { items: ProjectSummary[] }).items.map((item) => ({
            name: item.name ?? "(unnamed)",
            projectId: item.projectId,
            description: item.description || "—",
            createdAt: humanTime(item.createdAt),
          }));
          return table(rows, [
            { key: "name", label: "Project" },
            { key: "projectId", label: "projectId" },
            { key: "description", label: "Description" },
            { key: "createdAt", label: "Created" },
          ]);
        },
      });
    },
  );

  /* -------------------------------------------------------- environments */

  defineTool(
    server,
    context,
    "dokploy_list_environments",
    {
      title: "List Environments In A Project",
      description: `List the environments (e.g. production, staging) belonging to a project.

Every application, compose stack and database is created inside an environment, so this is
what you need before creating anything.

Args:
  - projectId (string, required): The owning project

Returns:
  { "items": [ { "environmentId": "3dFId8fY7…", "name": "production", "isDefault": true } ],
    "total": 1 }

Examples:
  - Use when: "deploy to staging" -> list environments, pick the one named staging
  - Use when: about to create a service and need an environmentId

Error Handling:
  - 404 -> wrong projectId`,
      inputSchema: z
        .object({
          projectId: z.string().min(1).describe("The owning project id"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ projectId }): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("environment.byProjectId", { projectId });
      const items = Array.isArray(payload) ? payload : ((payload as { items?: unknown[] })?.items ?? []);
      const page = paginate(items as Record<string, unknown>[], 100, 0);
      return renderResult({
        format: "markdown",
        title: `Environments in project ${projectId} (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `Project ${projectId} has no environments.`,
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((env) => ({
            name: (env.name as string) ?? "(unnamed)",
            environmentId: (env.environmentId as string) ?? "—",
            isDefault: env.isDefault === true ? "yes" : "no",
            createdAt: humanTime(env.createdAt),
          }));
          return table(rows, [
            { key: "name", label: "Environment" },
            { key: "environmentId", label: "environmentId" },
            { key: "isDefault", label: "Default" },
            { key: "createdAt", label: "Created" },
          ]);
        },
      });
    },
  );

  /* ------------------------------------------------------------- servers */

  defineTool(
    server,
    context,
    "dokploy_list_servers",
    {
      title: "List Dokploy Servers",
      description: `List the servers registered with this instance.

A single Dokploy instance can manage several Docker hosts. Services created without an
explicit \`serverId\` land on the instance's own host; pass one of these ids to place a
service elsewhere.

Args: none

Returns:
  { "items": [ { "serverId": "…", "name": "…", "ip": "…" } ], "total": 1 }

Examples:
  - Use when: creating a service that must run on a specific host
  - Don't use when: the instance manages one host -> omit serverId and let Dokploy choose

Error Handling:
  - Empty list is normal on a single-host install`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const payload = await context.client.query<ServerSummary[] | Paginated<ServerSummary>>(
        "server.all",
      );
      const items = Array.isArray(payload) ? payload : (payload?.items ?? []);
      const page = paginate(items, clampLimit(undefined), 0);
      return renderResult({
        format: "markdown",
        title: `Servers (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty:
          "No additional servers are registered. Services will be created on the instance's own host.",
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((server) => ({
            name: (server.name as string) ?? "(unnamed)",
            serverId: (server.serverId as string) ?? "—",
            ip: (server.ip as string) ?? "—",
          }));
          return table(rows, [
            { key: "name", label: "Server" },
            { key: "serverId", label: "serverId" },
            { key: "ip", label: "IP" },
          ]);
        },
      });
    },
  );

  /* --------------------------------------------------------------- tags */

  defineTool(
    server,
    context,
    "dokploy_list_tags",
    {
      title: "List Project Tags",
      description: `List the tags used to group and filter projects.

Args: none

Returns: { "items": [ { "tagId": "…", "name": "production", "color": "…" } ], "total": 3 }

Examples:
  - Use when: grouping or filtering projects by tag
  - Don't use when: you need the services inside a project -> use dokploy_list_projects

Error Handling:
  - None expected`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("tag.all");
      const items = Array.isArray(payload) ? payload : ((payload as { items?: unknown[] })?.items ?? []);
      const page = paginate(items as Record<string, unknown>[], 100, 0);
      return renderResult({
        format: "markdown",
        title: `Tags (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "No tags are defined.",
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((tag) => ({
            name: (tag.name as string) ?? "(unnamed)",
            tagId: (tag.tagId as string) ?? "—",
            color: (tag.color as string) ?? "—",
          }));
          return table(rows, [
            { key: "name", label: "Tag" },
            { key: "tagId", label: "tagId" },
            { key: "color", label: "Colour" },
          ]);
        },
      });
    },
  );
}
