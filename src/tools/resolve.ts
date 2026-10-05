/**
 * Name -> id resolution.
 *
 * This is the most important file in the server. Every Dokploy procedure addresses its
 * resource by an opaque id (`environmentId: "3dFId8fY7N0ujnExgYYKL"`), and nothing in the
 * API maps a human name to one. An agent that cannot resolve names must round-trip through
 * `project.all` and hand-match ids by hand on every task — that is the single biggest
 * source of failed tool calls against this API.
 *
 * Both tools here read `project.all`, which already nests every project, environment and
 * service with ids inline, so one request yields the whole index.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { humanTime, renderResult, table } from "../format.js";
import type {
  DomainRecord,
  Deployment,
  Project,
  ProjectEnvironment,
  ProjectTreeService,
  ResolvedService,
  ServiceType,
} from "../types.js";
import { SERVICE_TYPES } from "../types.js";
import { IdSchema, ResponseFormatSchema } from "../schemas/common.js";
import { defineTool, READ_ONLY, type ToolContext, type ToolResult } from "./registry.js";

/** The keys `project.all` uses per service type inside each environment. */
const TREE_KEYS: Record<ServiceType, keyof ProjectEnvironment> = {
  application: "applications",
  compose: "compose",
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongo",
  redis: "redis",
  libsql: "libsql",
};

const ID_KEYS: Record<ServiceType, string> = {
  application: "applicationId",
  compose: "composeId",
  postgres: "postgresId",
  mysql: "mysqlId",
  mariadb: "mariadbId",
  mongo: "mongoId",
  redis: "redisId",
  libsql: "libsqlId",
};

const STATUS_KEYS: Record<ServiceType, string> = {
  application: "applicationStatus",
  compose: "composeStatus",
  postgres: "databaseStatus",
  mysql: "databaseStatus",
  mariadb: "databaseStatus",
  mongo: "databaseStatus",
  redis: "databaseStatus",
  libsql: "databaseStatus",
};

/** Flattens `project.all` into a searchable index, preserving project/environment context. */
export async function loadServiceIndex(client: ToolContext["client"]): Promise<ResolvedService[]> {
  const projects = await client.query<Project[]>("project.all");
  const index: ResolvedService[] = [];

  for (const project of projects ?? []) {
    for (const environment of project.environments ?? []) {
      for (const type of SERVICE_TYPES) {
        const services = (environment[TREE_KEYS[type]] ?? []) as ProjectTreeService[];
        for (const service of services) {
          const id = service[ID_KEYS[type]];
          if (typeof id !== "string" || id.length === 0) continue;
          const status = service[STATUS_KEYS[type]];
          index.push({
            type,
            id,
            name: typeof service.name === "string" ? service.name : undefined,
            appName: typeof service.appName === "string" ? service.appName : undefined,
            status: typeof status === "string" ? status : undefined,
            projectId: project.projectId,
            projectName: project.name,
            environmentId: environment.environmentId,
            environmentName: environment.name,
          });
        }
      }
    }
  }

  return index;
}

/** Case-insensitive containment against every identifier a service goes by. */
function matches(service: ResolvedService, needle: string, exact: boolean): boolean {
  const target = needle.toLowerCase();
  const candidates = [service.name, service.appName, service.id].filter(
    (value): value is string => typeof value === "string",
  );
  if (candidates.length === 0) return false;
  if (exact) {
    return candidates.some((value) => value.toLowerCase() === target);
  }
  return candidates.some((value) => value.toLowerCase().includes(target));
}

export interface ResolveOptions {
  name: string;
  project?: string | undefined;
  environment?: string | undefined;
  type?: ServiceType | undefined;
  exact?: boolean | undefined;
}

export interface ResolveOutcome {
  match?: ResolvedService;
  candidates: ResolvedService[];
  /** All services in the instance, for "did you mean" hints when nothing matched. */
  everything: ResolvedService[];
}

export function resolveFromIndex(index: ResolvedService[], options: ResolveOptions): ResolveOutcome {
  const { name, project, environment, type, exact = false } = options;

  let pool = index;
  if (type) pool = pool.filter((service) => service.type === type);
  if (project) {
    const wanted = project.toLowerCase();
    pool = pool.filter(
      (service) =>
        service.projectName?.toLowerCase() === wanted ||
        service.projectId === project ||
        service.projectName?.toLowerCase().includes(wanted),
    );
  }
  if (environment) {
    const wanted = environment.toLowerCase();
    pool = pool.filter(
      (service) =>
        service.environmentName?.toLowerCase() === wanted ||
        service.environmentId === environment ||
        service.environmentName?.toLowerCase().includes(wanted),
    );
  }

  const hits = pool.filter((service) => matches(service, name, exact));
  // An exact match anywhere in the instance beats a fuzzy hit inside a narrowed pool:
  // an agent asking for "api" means the service literally named api, not a substring.
  const exactHits = hits.filter((service) => matches(service, name, true));
  const ranked = exactHits.length > 0 ? exactHits : hits;

  return {
    match: ranked.length === 1 ? ranked[0] : undefined,
    candidates: ranked,
    everything: index,
  };
}

/** Nearest names, used to make a "not found" error useful. */
function suggestions(index: ResolvedService[], name: string, limit = 8): string {
  const target = name.toLowerCase();
  const scored = index
    .map((service) => {
      const values = [service.name, service.appName].filter(
        (value): value is string => typeof value === "string",
      );
      let best = Number.POSITIVE_INFINITY;
      for (const value of values) {
        const lower = value.toLowerCase();
        if (lower.startsWith(target.slice(0, 3))) best = Math.min(best, 0);
        else if (lower.includes(target.slice(0, 4))) best = Math.min(best, 1);
        else best = Math.min(best, lower.length);
      }
      return { service, best };
    })
    .filter((entry) => Number.isFinite(entry.best))
    .sort((a, b) => a.best - b.best)
    .slice(0, limit);

  if (scored.length === 0) return "";
  return scored
    .map(
      ({ service }) =>
        `- ${service.name ?? service.appName ?? "(unnamed)"} (${service.type}) in ` +
        `${service.projectName ?? "?"}/${service.environmentName ?? "?"} — \`${service.id}\``,
    )
    .join("\n");
}

/**
 * Deployment history for a service.
 *
 * The three listing procedures are not interchangeable: `deployment.all` requires
 * `applicationId` and `deployment.allByCompose` requires `composeId`. Both mark their id
 * as required, so sending the wrong one — or omitting it, which is what happens if an
 * undefined param is dropped — is a 400. The six database engines belong to neither
 * namespace, so they read from the centralised listing.
 */
async function listDeploymentsFor(
  client: ToolContext["client"],
  type: ServiceType,
  id: string,
): Promise<Deployment[]> {
  try {
    if (type === "application") {
      return (await client.query<Deployment[]>("deployment.all", { applicationId: id })) ?? [];
    }
    if (type === "compose") {
      return (await client.query<Deployment[]>("deployment.allByCompose", { composeId: id })) ?? [];
    }
    return (await client.query<Deployment[]>("deployment.allCentralized")) ?? [];
  } catch {
    // Deployment history is supplementary context here. A failure must not sink the whole
    // describe call — the service config and domains are still worth returning.
    return [];
  }
}

function describeMatch(service: ResolvedService): string[] {  return [
    `- **Type**: ${service.type}`,
    `- **Id**: \`${service.id}\``,
    `- **Name**: ${service.name ?? "—"}`,
    ...(service.appName ? [`- **appName**: \`${service.appName}\``] : []),
    `- **Status**: ${service.status ?? "unknown"}`,
    `- **Project**: ${service.projectName ?? "—"} (\`${service.projectId ?? "?"}\`)`,
    `- **Environment**: ${service.environmentName ?? "—"} (\`${service.environmentId ?? "?"}\`)`,
  ];
}

export function registerResolve(server: McpServer, context: ToolContext): void {
  defineTool(
    server,
    context,
    "dokploy_resolve_service",
    {
      title: "Resolve A Dokploy Service Name To Its Id",
      description: `Resolve a human-readable service name to the ids every other Dokploy tool needs.

Dokploy addresses every resource by an opaque id (e.g. "3dFId8fY7N0ujnExgYYKL") and exposes no
lookup for it. Call this tool whenever you hold a name instead of an id. It searches
applications, compose stacks and all six database engines at once, across every project.

Args:
  - name (string, required): Service name or appName to look for
  - project (string, optional): Narrow to this project name
  - environment (string, optional): Narrow to this environment name (e.g. "production")
  - type (enum, optional): 'application' | 'compose' | 'postgres' | 'mysql' | 'mariadb' |
    'mongo' | 'redis' | 'libsql'. Omit to search all types.
  - exact (boolean, optional): Require an exact name match before falling back to a partial
    one. Defaults to false.
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  A single match:
    { "match": { "type": "compose", "id": "zWYIcwaGz5…", "name": "cloudflare-ddns",
                 "status": "done", "projectName": "AI Router",
                 "environmentName": "production", "environmentId": "3dFId8fY7…" } }

  Or, when the name is ambiguous, every candidate so you can pick:
    { "match": null, "candidates": [ … ],
      "hint": "Multiple services match. Re-run with project/environment/type to disambiguate." }

Examples:
  - Use when: "restart cloudflare-ddns" -> { name: "cloudflare-ddns" }, then pass the id to
    dokploy_reload_compose
  - Use when: "what is the postgres id for the API project?" ->
    { name: "api", type: "postgres" }
  - Don't use when: you already hold an id -> pass it straight to the operation

Error Handling:
  - No match -> reports how many services were searched and lists the closest names
  - Ambiguous -> never picks one arbitrarily; returns candidates and asks you to narrow`,
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Service name or appName to look for"),
          project: z.string().optional().describe("Narrow to this project name"),
          environment: z.string().optional().describe("Narrow to this environment name"),
          type: z
            .enum(SERVICE_TYPES)
            .optional()
            .describe("Restrict to one service type. Omit to search all"),
          exact: z
            .boolean()
            .optional()
            .describe("Require an exact name match before falling back to partial matching"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const index = await loadServiceIndex(context.client);
      const outcome = resolveFromIndex(index, input);
      const { match, candidates } = outcome;

      if (match) {
        return renderResult({
          format: input.response_format,
          title: `Resolved ${match.type} "${match.name ?? input.name}"`,
          structured: { match, candidateCount: candidates.length },
          markdown: () => describeMatch(match).join("\n"),
        });
      }

      if (candidates.length > 1) {
        const scope = [
          input.project ? `project="${input.project}"` : null,
          input.environment ? `environment="${input.environment}"` : null,
          input.type ? `type="${input.type}"` : null,
        ].filter(Boolean);
        return renderResult({
          format: input.response_format,
          title: `Ambiguous: ${candidates.length} services match "${input.name}"`,
          structured: {
            match: null,
            candidateCount: candidates.length,
            candidates,
            hint:
              "Multiple services match. Re-run with `project`, `environment` or `type` to " +
              "narrow, or match one of these ids directly." +
              (scope.length > 0 ? ` Current filters: ${scope.join(", ")}.` : ""),
          },
          markdown: () =>
            [
              `_${candidates.length} services match "${input.name}". This tool will not pick one for you._`,
              "",
              table(
                candidates.map((service) => ({
                  name: service.name ?? service.appName ?? "(unnamed)",
                  type: service.type,
                  id: service.id,
                  project: service.projectName ?? "—",
                  environment: service.environmentName ?? "—",
                  status: service.status ?? "—",
                })),
                [
                  { key: "name", label: "Name" },
                  { key: "type", label: "Type" },
                  { key: "id", label: "Id" },
                  { key: "project", label: "Project" },
                  { key: "environment", label: "Environment" },
                  { key: "status", label: "Status" },
                ],
              ),
            ].join("\n"),
        });
      }

      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `No Dokploy service matches "${input.name}". ` +
              `Searched ${index.length} services across ${new Set(index.map((s) => s.projectId)).size} projects` +
              `${input.type ? ` of type ${input.type}` : ""}.` +
              (suggestions(index, input.name)
                ? `\n\nDid you mean:\n${suggestions(index, input.name)}`
                : "\n\nThis instance has no services to search."),
          },
        ],
      };
    },
  );

  /* ------------------------------------------------------ describe_service */

  defineTool(
    server,
    context,
    "dokploy_describe_service",
    {
      title: "Describe A Dokploy Service In One Call",
      description: `Full operational context for one service: configuration, domains, recent deployments
and current status.

This replaces four separate calls (resolve, get one, list domains, list deployments) with one.
Prefer it whenever you need to understand a service before acting on it.

Args:
  - name (string, required): Service name or appName
  - project (string, optional): Narrow to this project name
  - environment (string, optional): Narrow to this environment name
  - type (enum, optional): Restrict to one service type
  - include_deployments (number, optional): How many recent deployments to include (0-20,
    default 5)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "service": { "type", "id", "name", "status", … }, "domains": [...],
    "recentDeployments": [ { "deploymentId", "status", "title", "createdAt" } ] }

Examples:
  - Use when: "why is my API down?" -> this, then dokploy_get_application_logs
  - Use when: "what domain does the UI point at?" -> read \`domains\`
  - Don't use when: you only need the id -> use dokploy_resolve_service, which is cheaper

Error Handling:
  - No match -> reports the closest names, as resolve_service does
  - Ambiguous -> returns candidates rather than guessing`,
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Service name or appName"),
          project: z.string().optional().describe("Narrow to this project name"),
          environment: z.string().optional().describe("Narrow to this environment name"),
          type: z.enum(SERVICE_TYPES).optional().describe("Restrict to one service type"),
          include_deployments: z
            .number()
            .int()
            .min(0)
            .max(20)
            .default(5)
            .describe("How many recent deployments to include (0-20, default 5)"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const index = await loadServiceIndex(context.client);
      const outcome = resolveFromIndex(index, input);
      const { match, candidates } = outcome;

      if (!match) {
        if (candidates.length > 1) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `"${input.name}" matches ${candidates.length} services: ` +
                  candidates
                    .map(
                      (c) => `${c.name ?? c.appName} (${c.type}) in ${c.projectName}/${c.environmentName} = ${c.id}`,
                    )
                    .join("; ") +
                  ". Re-run with project, environment or type to disambiguate.",
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `No Dokploy service matches "${input.name}" (searched ${index.length} services).` +
                (suggestions(index, input.name) ? `\n\nDid you mean:\n${suggestions(index, input.name)}` : ""),
            },
          ],
        };
      }

      // Configuration, domains and deployments are fetched concurrently: this tool exists
      // to collapse round-trips, so it should not serialise three independent reads.
      const configProcedure = `${match.type}.one`;
      const domainsProcedure =
        match.type === "application"
          ? "domain.byApplicationId"
          : match.type === "compose"
            ? "domain.byComposeId"
            : null;

      const [config, domains, deployments] = await Promise.all([
        context.client.query<Record<string, unknown>>(configProcedure, {
          [ID_KEYS[match.type]]: match.id,
        }),
        domainsProcedure
          ? context.client
              .query<DomainRecord[]>(domainsProcedure, {
                [ID_KEYS[match.type === "application" ? "application" : "compose"]]: match.id,
              })
              .catch(() => [] as DomainRecord[])
          : Promise.resolve([] as DomainRecord[]),
        input.include_deployments > 0
          ? listDeploymentsFor(context.client, match.type, match.id)
          : Promise.resolve([] as Deployment[]),
      ]);

      const recent = deployments
        .slice(0, input.include_deployments)
        .map((deployment) => ({
          deploymentId: deployment.deploymentId,
          title: deployment.title ?? "",
          status: deployment.status ?? "unknown",
          createdAt: deployment.createdAt,
          finishedAt: deployment.finishedAt,
        }));

      const structured = {
        service: { ...match, config },
        domains: domains ?? [],
        recentDeployments: recent,
      };

      return renderResult({
        format: input.response_format,
        title: `${match.type} "${match.name ?? match.appName ?? match.id}"`,
        structured,
        markdown: () =>
          [
            ...describeMatch(match),
            "",
            "### Domains",
            (domains ?? []).length === 0
              ? "_none configured_"
              : table(
                  (domains ?? []).map((domain) => ({
                    host: domain.host ?? "—",
                    port: domain.port ?? "—",
                    https: domain.https === true ? "yes" : "no",
                    certificateType: domain.certificateType ?? "—",
                  })),
                  [
                    { key: "host", label: "Host" },
                    { key: "port", label: "Port" },
                    { key: "https", label: "HTTPS" },
                    { key: "certificateType", label: "Certificate" },
                  ],
                ),
            "",
            "### Recent deployments",
            recent.length === 0
              ? "_none_"
              : table(recent, [
                  { key: "status", label: "Status" },
                  { key: "title", label: "Title" },
                  { key: "deploymentId", label: "deploymentId" },
                  { key: "createdAt", label: "Started" },
                  { key: "finishedAt", label: "Finished" },
                ]),
          ].join("\n"),
      });
    },
  );

  /* ----------------------------------------------- search by name (all) */

  defineTool(
    server,
    context,
    "dokploy_search_services",
    {
      title: "Search Services Across All Types",
      description: `Search applications, compose stacks and all six database engines by name at once.

Broader than the per-type \`search\` tools: it searches every type and every project, and
returns which project and environment each result belongs to. Use it when you do not know
what kind of service you are looking for.

Args:
  - q (string, optional): Free-text match. Omit to list everything.
  - project (string, optional): Narrow to this project name
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "total": 7, "count": 7, "offset": 0, "items": [ … ], "has_more": false }

Examples:
  - Use when: "is there anything called redis?" -> { q: "redis" }
  - Use when: starting from scratch and wanting an inventory -> omit \`q\`

Error Handling:
  - No match -> an empty items array with has_more false`,
      inputSchema: z
        .object({
          q: z.string().optional().describe("Free-text match. Omit to list everything"),
          project: z.string().optional().describe("Narrow to this project name"),
          limit: z.number().int().min(1).max(100).default(20).describe("1-100, default 20"),
          offset: z.number().int().min(0).default(0).describe("Rows to skip, default 0"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const index = await loadServiceIndex(context.client);
      let pool = index;
      if (input.project) {
        const wanted = input.project.toLowerCase();
        pool = pool.filter(
          (service) =>
            service.projectName?.toLowerCase().includes(wanted) || service.projectId === input.project,
        );
      }
      if (input.q) {
        const needle = input.q.toLowerCase();
        pool = pool.filter((service) =>
          [service.name, service.appName].some(
            (value) => typeof value === "string" && value.toLowerCase().includes(needle),
          ),
        );
      }
      const total = pool.length;
      const items = pool.slice(input.offset, input.offset + input.limit);
      const hasMore = input.offset + items.length < total;
      const structured: Record<string, unknown> = {
        total,
        count: items.length,
        offset: input.offset,
        items,
        has_more: hasMore,
      };
      if (hasMore) structured.next_offset = input.offset + items.length;

      return renderResult({
        format: input.response_format,
        title: `Services${input.q ? ` matching "${input.q}"` : ""} (${items.length}/${total})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `No services matched${input.q ? ` "${input.q}"` : ""} on this instance.`,
        markdown: (data) => {
          const rows = (data as { items: ResolvedService[] }).items.map((service) => ({
            name: service.name ?? service.appName ?? "(unnamed)",
            type: service.type,
            id: service.id,
            project: service.projectName ?? "—",
            environment: service.environmentName ?? "—",
            status: service.status ?? "—",
          }));
          return table(rows, [
            { key: "name", label: "Name" },
            { key: "type", label: "Type" },
            { key: "id", label: "Id" },
            { key: "project", label: "Project" },
            { key: "environment", label: "Environment" },
            { key: "status", label: "Status" },
          ]);
        },
      });
    },
  );
}

export { IdSchema, humanTime };
