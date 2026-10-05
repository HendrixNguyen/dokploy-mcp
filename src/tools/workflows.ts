/**
 * Composite workflow tools.
 *
 * Everything else in this server is a thin wrapper over one Dokploy procedure, which makes
 * each call predictable but leaves an agent to assemble the sequence itself: resolve a name
 * to an id, deploy, then find the deployment it just started. That is four round-trips and
 * three places to get an id wrong, and an id guessed wrong deploys the wrong service.
 *
 * These three tools exist so an agent can ask for a task by name. They chain procedures, they
 * resolve names through the same index `dokploy_resolve_service` uses, and they return the
 * generated ids a caller needs next. None of them invents behaviour Dokploy does not have:
 * where a chain cannot be completed — a compose stack with no container to read logs from,
 * a create that fails halfway — the tool says so instead of pretending.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_LOG_TAIL, LOG_TIMEOUT_MS, MAX_LOG_TAIL } from "../constants.js";
import { humanTime, renderResult, table } from "../format.js";
import type {
  DatabaseType,
  Deployment,
  DomainRecord,
  ResolvedService,
  ServiceType,
} from "../types.js";
import { DATABASE_TYPES, SERVICE_TYPES } from "../types.js";
import { AppNameSchema, ConfirmSchema, PasswordSchema, ResponseFormatSchema } from "../schemas/common.js";
import {
  defineTool,
  DISRUPTIVE,
  READ_ONLY,
  requireConfirmation,
  type ToolContext,
  type ToolResult,
} from "./registry.js";
import { loadServiceIndex, resolveFromIndex } from "./resolve.js";

/* --------------------------------------------------------- procedure maps */

/**
 * Every service type is addressed by `<type>.<verb>`, but the id argument and the deployment
 * listing differ per type, so each map lives here rather than being rebuilt at each call
 * site. This is the mapping that §4 of the plan calls the main source of bugs in
 * consolidated database tools.
 */
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

const DEPLOY_PROCEDURES: Record<ServiceType, string> = {
  application: "application.deploy",
  compose: "compose.deploy",
  postgres: "postgres.deploy",
  mysql: "mysql.deploy",
  mariadb: "mariadb.deploy",
  mongo: "mongo.deploy",
  redis: "redis.deploy",
  libsql: "libsql.deploy",
};

const READ_LOGS_PROCEDURES: Record<ServiceType, string> = {
  application: "application.readLogs",
  compose: "compose.readLogs",
  postgres: "postgres.readLogs",
  mysql: "mysql.readLogs",
  mariadb: "mariadb.readLogs",
  mongo: "mongo.readLogs",
  redis: "redis.readLogs",
  libsql: "libsql.readLogs",
};

/**
 * Only applications and compose stacks carry the optional `title`/`description` a deploy
 * records. Sending them to an engine that does not declare them risks a zod rejection, so
 * they are attached only where the pinned spec lists them.
 */
const DEPLOY_ACCEPTS_METADATA: Record<ServiceType, boolean> = {
  application: true,
  compose: true,
  postgres: false,
  mysql: false,
  mariadb: false,
  mongo: false,
  redis: false,
  libsql: false,
};

/** Only applications and compose stacks have domains; databases have no domain records. */
const DOMAIN_PROCEDURES: Partial<Record<ServiceType, { procedure: string; idKey: string }>> = {
  application: { procedure: "domain.byApplicationId", idKey: "applicationId" },
  compose: { procedure: "domain.byComposeId", idKey: "composeId" },
};

/**
 * Deployment history is only addressable for applications and compose stacks in v0.30.8:
 * `deployment.all` requires an `applicationId` and `deployment.allByCompose` a `composeId`,
 * while the generic `deployment.allByType` accepts only
 * `application|compose|server|schedule|previewDeployment|backup|volumeBackup`. A database
 * deployment records no entry under any of those keys, so the six engines are reported as
 * untracked rather than queried with an id that would never match.
 */
const DEPLOYMENT_LISTINGS: Partial<
  Record<ServiceType, { procedure: string; params: (id: string) => Record<string, unknown> }>
> = {
  application: { procedure: "deployment.all", params: (id) => ({ applicationId: id }) },
  compose: { procedure: "deployment.allByCompose", params: (id) => ({ composeId: id }) },
};

/* ---------------------------------------------------------------- helpers */

function toItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}

/** Dokploy declares every mutation body as a bare `object`, so ids are read defensively. */
function readId(payload: unknown, ...keys: string[]): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    // tRPC sometimes nests the created object under its own singular key.
    if (value && typeof value === "object") {
      const inner = value as Record<string, unknown>;
      for (const innerKey of keys) {
        const innerValue = inner[innerKey];
        if (typeof innerValue === "string" && innerValue.length > 0) return innerValue;
      }
    }
  }
  return undefined;
}

/** Newest first by `createdAt`, so the head of the list is the deployment just started. */
function newestFirst(deployments: Deployment[]): Deployment[] {
  return [...deployments].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
}

interface ResolveCriteria {
  name: string;
  project?: string | undefined;
  environment?: string | undefined;
  type?: ServiceType | undefined;
}

/**
 * Resolves a name, or refuses with the reason.
 *
 * Both outcomes are returned rather than thrown so the caller can decide how to phrase the
 * failure. Ambiguity is never resolved by picking a candidate: an agent that deploys the
 * wrong service because two services had similar names is worse than one that is asked.
 */
async function resolveOrRefuse(
  client: ToolContext["client"],
  criteria: ResolveCriteria,
): Promise<{ match: ResolvedService } | { refusal: ToolResult }> {
  const index = await loadServiceIndex(client);
  const { match, candidates } = resolveFromIndex(index, criteria);

  if (match) return { match };

  if (candidates.length > 1) {
    const scope = [
      criteria.project ? `project="${criteria.project}"` : null,
      criteria.environment ? `environment="${criteria.environment}"` : null,
      criteria.type ? `type="${criteria.type}"` : null,
    ].filter(Boolean);
    return {
      refusal: {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `"${criteria.name}" matches ${candidates.length} services. This tool will not pick one ` +
              `for you.\n\n` +
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
              ) +
              `\n\nRe-run with project, environment or type to narrow.` +
              (scope.length > 0 ? ` Current filters: ${scope.join(", ")}.` : ""),
          },
        ],
      },
    };
  }

  return {
    refusal: {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `No Dokploy service matches "${criteria.name}". ` +
            `Searched ${index.length} services across ` +
            `${new Set(index.map((service) => service.projectId)).size} projects` +
            `${criteria.type ? ` of type ${criteria.type}` : ""}.` +
            `\n\nUse dokploy_list_projects to see what exists on this instance.`,
        },
      ],
    },
  };
}

function describe(service: ResolvedService): string[] {
  return [
    `- **Type**: ${service.type}`,
    `- **Id**: \`${service.id}\``,
    `- **Name**: ${service.name ?? "—"}`,
    `- **Status**: ${service.status ?? "unknown"}`,
    `- **Project**: ${service.projectName ?? "—"} (\`${service.projectId ?? "?"}\`)`,
    `- **Environment**: ${service.environmentName ?? "—"} (\`${service.environmentId ?? "?"}\`)`,
  ];
}

function recentDeploymentRows(deployments: Deployment[], limit: number): Record<string, unknown>[] {
  return deployments.slice(0, limit).map((deployment) => ({
    status: deployment.status ?? "unknown",
    title: deployment.title ?? "—",
    deploymentId: deployment.deploymentId,
    createdAt: humanTime(deployment.createdAt),
    finishedAt: humanTime(deployment.finishedAt),
  }));
}

const DEPLOYMENT_COLUMNS = [
  { key: "status", label: "Status" },
  { key: "title", label: "Title" },
  { key: "deploymentId", label: "deploymentId" },
  { key: "createdAt", label: "Started" },
  { key: "finishedAt", label: "Finished" },
];

/** `compose.readLogs` needs a containerId, and Dokploy only accepts `[a-zA-Z0-9.\-_]+` there. */
const CONTAINER_ID_PATTERN = /^[a-zA-Z0-9.\-_]+$/;

/** Which status field each engine's `one` response carries. */
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

/** Names the step that failed, so a partial provision can say which create stopped. */
class StepError extends Error {
  readonly step: string;

  constructor(step: string, detail?: string) {
    super(detail ? `${step}: ${detail}` : step);
    this.name = "StepError";
    this.step = step;
  }
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LogSection {
  logs: string | null;
  logsUnavailable?: string;
}

/**
 * Renders whatever `<type>.readLogs` returned. The response is declared as a bare object, so
 * the common shapes are unwrapped and anything else is shown as JSON rather than guessed at.
 */
function renderLogs(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["logs", "output", "stdout", "data"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  if (payload === null || payload === undefined) return "_no log output returned_";
  return JSON.stringify(payload, null, 2);
}

export function registerWorkflows(server: McpServer, context: ToolContext): void {
  /* --------------------------------------------------------- deploy by name */

  defineTool(
    server,
    context,
    "dokploy_deploy_service",
    {
      title: "Deploy A Dokploy Service By Name",
      description: `Deploy a service identified by its name, and return the id of the deployment it started.

This is the composite of three calls an agent would otherwise have to assemble: resolve the
name to an id, call the engine's deploy procedure, then work out which deployment to poll.
It returns the \`deploymentId\` so progress can be followed with a single follow-up read.

Args:
  - name (string, required): Service name or appName to deploy
  - project (string, optional): Narrow to this project name
  - environment (string, optional): Narrow to this environment name
  - type (enum, optional): 'application' | 'compose' | 'postgres' | 'mysql' | 'mariadb' |
    'mongo' | 'redis' | 'libsql'. Omit to search all types
  - title (string, optional): Deployment title recorded in the history. Recorded for
    applications and compose stacks; the database engines do not accept one
  - description (string, optional): Deployment description, same caveat as \`title\`
  - confirm (boolean, required): Must be true. A deploy replaces the running containers

Returns:
  { "service": { "type": "application", "id": "…", "name": "api" },
    "deploymentId": "…", "title": "…", "procedure": "application.deploy",
    "poll": "GET deployment.all?applicationId=…" }

Examples:
  - Use when: "deploy the API" -> { name: "api", confirm: true }, then poll the deploymentId
  - Use when: two services share a name -> add project/environment/type so the choice is explicit
  - Don't use when: the container is wedged but the source is unchanged ->
    dokploy_restart_container is faster and does not rebuild

Error Handling:
  - confirm !== true -> refuses without calling the API
  - No match -> reports how many services were searched and points at dokploy_list_projects
  - Ambiguous -> returns every candidate and refuses to pick one; this tool never guesses
  - The deployment is queued, not finished: a 200 here means the build started, not that it passed`,
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Service name or appName to deploy"),
          project: z.string().optional().describe("Narrow to this project name"),
          environment: z.string().optional().describe("Narrow to this environment name"),
          type: z.enum(SERVICE_TYPES).optional().describe("Restrict to one service type"),
          title: z.string().optional().describe("Deployment title, recorded for applications and compose"),
          description: z
            .string()
            .optional()
            .describe("Deployment description, recorded for applications and compose"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DISRUPTIVE,
    },
    async (input): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        input.confirm === true,
        "Deploying a service replaces its running containers with a fresh build.",
        "Re-run with confirm: true once you have checked the name resolves to the service you meant.",
      );
      if (refusal) return refusal;

      const resolved = await resolveOrRefuse(context.client, input);
      if ("refusal" in resolved) return resolved.refusal;
      const { match } = resolved;

      const body: Record<string, unknown> = { [ID_KEYS[match.type]]: match.id };
      if (DEPLOY_ACCEPTS_METADATA[match.type]) {
        if (input.title !== undefined) body.title = input.title;
        if (input.description !== undefined) body.description = input.description;
      }

      const procedure = DEPLOY_PROCEDURES[match.type];
      const response = await context.client.mutation<unknown>(procedure, body);
      const listing = DEPLOYMENT_LISTINGS[match.type];

      // Dokploy's deploy mutation returns the deployment it created, but the spec declares
      // the body as a bare object. When `deploymentId` is absent and the type has a
      // deployment listing, the id is recovered from the newest entry rather than reported
      // as unknown.
      let deploymentId = readId(response, "deploymentId", "id");
      let deploymentIdSource: "response" | "listing" | "unavailable" = "response";
      if (!deploymentId && listing) {
        const deployments = await context.client
          .query<Deployment[]>(listing.procedure, listing.params(match.id))
          .catch(() => [] as Deployment[]);
        deploymentId = newestFirst(deployments)[0]?.deploymentId;
        if (deploymentId) deploymentIdSource = "listing";
      }
      if (!deploymentId) deploymentIdSource = "unavailable";

      const structured = {
        service: {
          type: match.type,
          id: match.id,
          name: match.name ?? match.appName,
          project: match.projectName ?? null,
          environment: match.environmentName ?? null,
        },
        procedure,
        deploymentId: deploymentId ?? null,
        deploymentIdSource,
        response,
        poll: listing ? `${listing.procedure} ${JSON.stringify(listing.params(match.id))}` : null,
        deploymentTracked: listing !== undefined,
      };

      return renderResult({
        format: "markdown",
        title: `Deploying ${match.type} "${match.name ?? match.appName ?? match.id}"`,
        structured,
        markdown: (data) => {
          const deploymentId = (data as { deploymentId: string | null }).deploymentId;
          const tracked = (data as { deploymentTracked: boolean }).deploymentTracked;
          return [
            ...describe(match),
            `- **Procedure**: \`${procedure}\``,
            `- **deploymentId**: ${deploymentId ? `\`${deploymentId}\`` : "not returned by Dokploy"}`,
            "",
            deploymentId && tracked
              ? `The deployment has been queued. Poll \`${listing?.procedure}\` until its status leaves \`pending\`.`
              : tracked
                ? "Dokploy did not return a deploymentId. Read the deployment listing to follow progress."
                : "Database deployments are not recorded in Dokploy's deployment history, so there is " +
                  "no deploymentId to poll. Check the service with dokploy_get_service_health instead.",
          ].join("\n");
        },
      });
    },
  );

  /* ------------------------------------------------------------- health */

  defineTool(
    server,
    context,
    "dokploy_get_service_health",
    {
      title: "Answer Whether A Service Is Healthy, In One Call",
      description: `Status, domains, recent deployments and log tail for one service, resolved by name.

"Is it healthy?" is the most common operational question and it does not fit a single Dokploy
procedure: the answer is spread across the service record, its domain records, its deployment
history and its container logs. This tool fetches all four concurrently and answers with one
payload.

Args:
  - name (string, required): Service name or appName
  - project (string, optional): Narrow to this project name
  - environment (string, optional): Narrow to this environment name
  - type (enum, optional): Restrict to one service type
  - logTail (number, optional): How many log lines to include, 1-10000 (default 200). Pass 0 to
    skip logs entirely
  - includeDeployments (number, optional): How many recent deployments to include, 0-20 (default 5)
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "service": { "type", "id", "name", "status" },
    "domains": [ { "host", "port", "https", "certificateType" } ],
    "recentDeployments": [ { "deploymentId", "status", "title" } ],
    "logs": "…", "logsUnavailable": "why the log section is missing" }

Examples:
  - Use when: "is the API healthy?" -> { name: "api" }
  - Use when: "why did it just go red?" -> { name: "api", logTail: 500 }
  - Don't use when: you only need the service id -> use dokploy_resolve_service, which is cheaper
  - Don't use when: the container is wedged and you know it -> use
    dokploy_restart_container, then re-check with this tool

Error Handling:
  - No match -> reports what was searched and points at dokploy_list_projects
  - Ambiguous -> returns every candidate and refuses to pick one
  - Logs are omitted, not fatal: a compose stack whose containers cannot be located reports
    \`logsUnavailable\` and the rest of the health report is still returned`,
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Service name or appName"),
          project: z.string().optional().describe("Narrow to this project name"),
          environment: z.string().optional().describe("Narrow to this environment name"),
          type: z.enum(SERVICE_TYPES).optional().describe("Restrict to one service type"),
          logTail: z
            .number()
            .int()
            .min(0)
            .max(MAX_LOG_TAIL)
            .default(DEFAULT_LOG_TAIL)
            .describe(
              `Log lines to include (0-${MAX_LOG_TAIL}, default ${DEFAULT_LOG_TAIL}). Pass 0 to skip logs`,
            ),
          includeDeployments: z
            .number()
            .int()
            .min(0)
            .max(20)
            .default(5)
            .describe("Recent deployments to include (0-20, default 5)"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const resolved = await resolveOrRefuse(context.client, input);
      if ("refusal" in resolved) return resolved.refusal;
      const { match } = resolved;
      const idKey = ID_KEYS[match.type];

      const configPromise = context.client
        .query<Record<string, unknown>>(`${match.type}.one`, { [idKey]: match.id })
        .catch(() => ({}) as Record<string, unknown>);

      const domainSpec = DOMAIN_PROCEDURES[match.type];
      const domainsPromise: Promise<DomainRecord[]> = domainSpec
        ? context.client
            .query<DomainRecord[]>(domainSpec.procedure, { [domainSpec.idKey]: match.id })
            .catch(() => [] as DomainRecord[])
        : Promise.resolve([] as DomainRecord[]);

      const listing = DEPLOYMENT_LISTINGS[match.type];
      const deploymentsPromise: Promise<Deployment[]> =
        input.includeDeployments > 0 && listing
          ? context.client
              .query<Deployment[]>(listing.procedure, listing.params(match.id))
              .catch(() => [] as Deployment[])
          : Promise.resolve([] as Deployment[]);

      // Logs are awaited alongside the rest, not after them. For compose the container id
      // comes out of the config response, so that promise is chained rather than serialised:
      // the four requests still overlap, and only the log section waits on the config.
      const logsPromise: Promise<LogSection> =
        input.logTail > 0
          ? (async (): Promise<LogSection> => {
              try {
                const params: Record<string, unknown> = { [idKey]: match.id, tail: input.logTail };
                if (match.type === "compose") {
                  const containerId = await resolveComposeContainer(
                    context.client,
                    await configPromise,
                  );
                  if (!containerId) {
                    return {
                      logs: null,
                      logsUnavailable:
                        "compose.readLogs needs a containerId and none could be resolved from the " +
                        "running containers of this stack. Find one with dokploy_list_containers.",
                    };
                  }
                  params.containerId = containerId;
                }
                const payload = await context.client.query<unknown>(
                  READ_LOGS_PROCEDURES[match.type],
                  params,
                  { timeoutMs: LOG_TIMEOUT_MS },
                );
                return { logs: renderLogs(payload) };
              } catch (error) {
                // A log tail that fails must not fail the health report: the status, domains
                // and deployment history are the answer to the question being asked.
                return { logs: null, logsUnavailable: describeFailure(error) };
              }
            })()
          : Promise.resolve({ logs: null, logsUnavailable: "skipped: logTail was 0" });

      const [config, domains, deployments, logs] = await Promise.all([
        configPromise,
        domainsPromise,
        deploymentsPromise,
        logsPromise,
      ]);

      const status =
        match.status ??
        (typeof config[STATUS_KEYS[match.type]] === "string"
          ? (config[STATUS_KEYS[match.type]] as string)
          : undefined) ??
        "unknown";
      const recentDeployments = recentDeploymentRows(
        newestFirst(deployments),
        input.includeDeployments,
      );

      const structured = {
        service: {
          type: match.type,
          id: match.id,
          name: match.name ?? match.appName ?? match.id,
          status,
          project: match.projectName ?? null,
          environment: match.environmentName ?? null,
          config,
        },
        domains: domains ?? [],
        recentDeployments,
        ...logs,
      };

      return renderResult({
        format: input.response_format,
        title: `${match.name ?? match.appName ?? match.id} — ${status}`,
        structured,
        markdown: (data) => {
          const payload = data as {
            domains: DomainRecord[];
            recentDeployments: Record<string, unknown>[];
            logs: string | null;
            logsUnavailable?: string;
          };
          return [
            `- **Type**: ${match.type}`,
            `- **Id**: \`${match.id}\``,
            `- **Status**: ${status}`,
            `- **Project**: ${match.projectName ?? "—"} (\`${match.projectId ?? "?"}\`)`,
            `- **Environment**: ${match.environmentName ?? "—"} (\`${match.environmentId ?? "?"}\`)`,
            "",
            "### Domains",
            DOMAIN_PROCEDURES[match.type]
              ? payload.domains.length === 0
                ? "_none configured_"
                : table(
                    payload.domains.map((domain) => ({
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
                  )
              : `_${match.type} services have no domains_`,
            "",
            "### Recent deployments",
            !DEPLOYMENT_LISTINGS[match.type]
              ? `_${match.type} deployments are not recorded in Dokploy's deployment history_`
              : payload.recentDeployments.length === 0
                ? "_none_"
                : table(payload.recentDeployments, DEPLOYMENT_COLUMNS),
            "",
            "### Logs",
            payload.logs === null
              ? `_unavailable — ${payload.logsUnavailable ?? "no reason reported"}_`
              : "```\n" + payload.logs + "\n```",
          ].join("\n");
        },
      });
    },
  );

  /* ------------------------------------------------------------ provision */

  /**
   * Per-engine required fields for `<type>.create`, transcribed from the pinned spec.
   * Validated here rather than at the server so a missing field is named before any resource
   * has been created.
   */
  const DATABASE_REQUIREMENTS: Record<DatabaseType, readonly string[]> = {
    postgres: ["databaseName", "databaseUser", "databasePassword"],
    mysql: ["databaseName", "databaseUser", "databasePassword"],
    mariadb: ["databaseName", "databaseUser", "databasePassword"],
    mongo: ["databaseUser", "databasePassword"],
    redis: ["databasePassword"],
    // libsql additionally requires appName, sqldNode and the nullable description/serverId
    // keys, which the create call fills in here.
    libsql: ["appName", "databaseUser", "databasePassword"],
  };

  const DatabaseSpec = z
    .object({
      type: z.enum(DATABASE_TYPES).describe("Which database engine to create"),
      name: z.string().min(1).describe("Display name of the database service"),
      databaseName: z
        .string()
        .min(1)
        .optional()
        .describe("Database name inside the engine. Required by postgres, mysql and mariadb"),
      databaseUser: z
        .string()
        .min(1)
        .optional()
        .describe("Application user. Required by everything except redis"),
      databasePassword: PasswordSchema.describe("Password for databaseUser"),
      appName: AppNameSchema.optional().describe("Container identifier. Required by libsql"),
    })
    .superRefine((value, ctx) => {
      const spec = value as Record<string, unknown>;
      for (const field of DATABASE_REQUIREMENTS[value.type]) {
        if (spec[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${value.type}.create requires \`${field}\``,
          });
        }
      }
    });

  defineTool(
    server,
    context,
    "dokploy_provision_service_stack",
    {
      title: "Provision An Environment, Database, Application And Domain",
      description: `Create the four resources a new service needs, in dependency order, and return every id.

A fresh service is four separate creates in three different namespaces, each needing the id
the previous one returned. This tool does that sequence — environment, database, application,
domain — and hands back \`environmentId\`, the database id, \`applicationId\` and \`domainId\`
so the caller can configure the application or attach a database immediately.

**This performs several creates.** It is not a dry run: a failure after the environment was
created leaves that environment in place, and the error names the step that failed and lists
what already exists. Re-running it is safe for the environment, which is reused by name
rather than duplicated.

Args:
  - projectId (string, required): Project the environment belongs to
  - environmentName (string, required): Name of the environment. An existing environment with
    this name is reused, not duplicated
  - database (object, optional): The database to create. Omit for an application with no
    database:
    - type (enum, required): 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis' | 'libsql'
    - name (string, required): Display name
    - databaseName (string, required for postgres/mysql/mariadb)
    - databaseUser (string, required for everything except redis)
    - databasePassword (string, required): Letters, digits and @#%^&*()_+-=[]{}|;:,.<>?~\`
    - appName (string, required for libsql): Container identifier, 1-63 of [a-zA-Z0-9._-]
  - application (object, required):
    - name (string, required): Display name
    - appName (string, optional): Container identifier, 1-63 of [a-zA-Z0-9._-]
    - description (string, optional)
  - domain (object, optional): A domain to attach to the new application:
    - host (string, required)
    - port (number, optional): 1-65535, the container port the domain routes to
    - https (boolean, optional): Request TLS. Default false
    - certificateType (enum, optional): 'letsencrypt' | 'none' | 'custom'. Dokploy only issues a
      certificate when this names one, so set it alongside \`https: true\`
  - sourceType (string, optional): Recorded as \`requestedSourceType\` in the result. Dokploy's
    v0.30.8 \`application.create\` does not accept a source type, so this is not sent on the
    create call — apply it with the application update tools afterwards
  - confirm (boolean, required): Must be true. This creates real resources on the instance

Returns:
  { "environmentId": "…", "environmentReused": false,
    "database": { "type": "postgres", "postgresId": "…" },
    "applicationId": "…", "domainId": "…",
    "created": [ "environment", "database", "application", "domain" ] }

Examples:
  - Use when: "set up staging with a Postgres and a domain" ->
    { projectId: "…", environmentName: "staging",
      database: { type: "postgres", name: "app-db", databaseName: "app",
                  databaseUser: "app", databasePassword: "…" },
      application: { name: "api" },
      domain: { host: "api.staging.example.com", port: 3000, https: true,
                certificateType: "letsencrypt" }, confirm: true }
  - Use when: the environment already exists -> re-run; it is reused and the remaining steps run
  - Don't use when: you are updating an existing service -> this only creates; use the
    application, database and domain tools for changes

Error Handling:
  - confirm !== true -> refuses without calling the API
  - A missing per-engine field is reported by schema validation before any create runs
  - If a step fails, the error names the step and lists the ids created so far; Dokploy does
    not roll back the earlier creates, and this tool does not pretend it did
  - 400 -> Dokploy rejected a field the pinned spec marked optional; the verbatim zod error is
    included`,
      inputSchema: z
        .object({
          projectId: z.string().min(1).describe("Project the environment belongs to"),
          environmentName: z.string().min(1).describe("Name of the environment to create or reuse"),
          database: DatabaseSpec.optional().describe("The database to create. Omit for none"),
          application: z
            .object({
              name: z.string().min(1).describe("Display name of the application"),
              appName: AppNameSchema.optional().describe("Container identifier"),
              description: z.string().optional().describe("Optional description"),
            })
            .describe("The application to create"),
          domain: z
            .object({
              host: z.string().min(1).describe("Domain host, e.g. api.example.com"),
              port: z
                .number()
                .int()
                .min(1)
                .max(65_535)
                .optional()
                .describe("Container port the domain routes to"),
              https: z.boolean().optional().describe("Request a TLS certificate"),
              certificateType: z
                .enum(["letsencrypt", "none", "custom"])
                .optional()
                .describe("Set alongside https: true, or no certificate is issued"),
            })
            .optional()
            .describe("A domain to attach to the new application"),
          sourceType: z
            .string()
            .optional()
            .describe(
              "Recorded in the result only: application.create does not accept a source type in v0.30.8",
            ),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DISRUPTIVE,
    },
    async (input): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        input.confirm === true,
        "This creates an environment and up to three more real resources. Dokploy does not undo them.",
        "Re-run with confirm: true once projectId, environmentName and the database credentials are right.",
      );
      if (refusal) return refusal;

      const created: string[] = [];
      const ids: Record<string, unknown> = {};
      let environmentReused = false;

      try {
        // 1. Environment — reused by name, because "provision staging" run twice should not
        //    leave two environments behind.
        const existingEnvironments = toItems<Record<string, unknown>>(
          await context.client.query<unknown>("environment.byProjectId", {
            projectId: input.projectId,
          }),
        );
        const existing = existingEnvironments.find(
          (environment) =>
            String(environment.name ?? "").toLowerCase() === input.environmentName.toLowerCase(),
        );
        const existingId =
          typeof existing?.environmentId === "string" ? existing.environmentId : undefined;
        if (existingId) {
          environmentReused = true;
          ids.environmentId = existingId;
        } else {
          const response = await context.client.mutation<unknown>("environment.create", {
            projectId: input.projectId,
            name: input.environmentName,
          });
          const id = readId(response, "environmentId", "id");
          if (!id) throw new StepError("environment.create", "Dokploy returned no environmentId");
          ids.environmentId = id;
          created.push("environment");
        }

        // 2. Database
        if (input.database) {
          const spec = input.database;
          const payload: Record<string, unknown> = {
            name: spec.name,
            appName: spec.appName,
            environmentId: ids.environmentId,
            databaseName: spec.databaseName,
            databaseUser: spec.databaseUser,
            databasePassword: spec.databasePassword,
          };
          if (spec.type === "libsql") {
            // libsql's create declares these keys required even when nullable or defaulted.
            payload.description = null;
            payload.serverId = null;
            payload.sqldNode = "primary";
            payload.sqldPrimaryUrl = null;
            payload.enableNamespaces = false;
          }
          const response = await context.client.mutation<unknown>(`${spec.type}.create`, payload);
          const id = readId(response, `${spec.type}Id`, "id");
          if (!id) throw new StepError(`${spec.type}.create`, "Dokploy returned no database id");
          ids.database = { type: spec.type, id, [`${spec.type}Id`]: id };
          created.push("database");
        }

        // 3. Application
        const applicationResponse = await context.client.mutation<unknown>("application.create", {
          environmentId: ids.environmentId,
          name: input.application.name,
          appName: input.application.appName,
          description: input.application.description ?? null,
        });
        const applicationId = readId(applicationResponse, "applicationId", "id");
        if (!applicationId) throw new StepError("application.create", "Dokploy returned no applicationId");
        ids.applicationId = applicationId;
        created.push("application");

        // 4. Domain
        if (input.domain) {
          const domainResponse = await context.client.mutation<unknown>("domain.create", {
            host: input.domain.host,
            port: input.domain.port,
            https: input.domain.https ?? false,
            certificateType: input.domain.certificateType,
            applicationId,
          });
          const domainId = readId(domainResponse, "domainId", "id");
          if (!domainId) throw new StepError("domain.create", "Dokploy returned no domainId");
          ids.domainId = domainId;
          created.push("domain");
        }
      } catch (error) {
        // A partial provision is a real state on the instance, so it is reported as one
        // rather than raised as a bare failure that hides what already exists.
        const step = error instanceof StepError ? error.step : describeFailure(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Provisioning stopped at: ${step}\n\n` +
                `Dokploy does not roll back what it already created. These resources now exist and are ` +
                `yours to keep or delete:\n` +
                (created.length === 0
                  ? "- (nothing was created before the failure)"
                  : created.map((name) => `- ${name}`).join("\n")) +
                `\n\nIds created so far: ${JSON.stringify(ids, null, 2)}`,
            },
          ],
        };
      }

      const structured = {
        projectId: input.projectId,
        environmentName: input.environmentName,
        environmentId: ids.environmentId,
        environmentReused,
        database: ids.database ?? null,
        applicationId: ids.applicationId,
        domainId: ids.domainId ?? null,
        requestedSourceType: input.sourceType ?? null,
        created,
      };

      return renderResult({
        format: "markdown",
        title: `Provisioned ${created.length} resource(s) in ${input.environmentName}`,
        structured,
        markdown: (data) => {
          const payload = data as {
            environmentId: string;
            environmentReused: boolean;
            database: { type: string; id: string } | null;
            applicationId: string;
            domainId: string | null;
            requestedSourceType: string | null;
            created: string[];
          };
          const database = payload.database;
          return [
            `- **Environment**: \`${payload.environmentId}\` (${payload.environmentReused ? "reused existing" : "created"})`,
            `- **Database**: ${database ? `${database.type} \`${database.id}\`` : "none requested"}`,
            `- **Application**: \`${payload.applicationId}\``,
            `- **Domain**: ${payload.domainId ? `\`${payload.domainId}\`` : "none requested"}`,
            payload.requestedSourceType
              ? `- **Requested source type**: ${payload.requestedSourceType} (not sent on create; apply it with an application update)`
              : "",
            `- **Created**: ${payload.created.join(", ") || "nothing"}`,
            "",
            "The application is created but not configured: no git source, build command, port or",
            "database connection has been set. Follow with the application configuration tools.",
          ]
            .filter(Boolean)
            .join("\n");
        },
      });
    },
  );
}

/* ------------------------------------------------------- compose containers */

/**
 * Finds a container for `compose.readLogs`, which cannot address a stack by id.
 *
 * Compose is a multi-container stack, so "the" container is ambiguous. The preference order
 * is: a container whose id Dokploy will accept, then one that is running, then the first
 * returned. When nothing matches, the caller degrades rather than guessing — reporting a
 * random container's logs as the stack's would be worse than reporting no logs.
 */
async function resolveComposeContainer(
  client: ToolContext["client"],
  config: Record<string, unknown>,
): Promise<string | undefined> {
  const appNameRaw = config.appName ?? config.name;
  if (typeof appNameRaw !== "string" || !CONTAINER_ID_PATTERN.test(appNameRaw)) return undefined;
  const appName = appNameRaw;

  // Both procedures are attempted because a compose stack is a Swarm service on some hosts
  // and a plain container set on others.
  const payloads = await Promise.all([
    client.query<unknown>("docker.getStackContainersByAppName", { appName }).catch(() => null),
    client
      .query<unknown>("docker.getContainersByAppLabel", { appName, type: "swarm" })
      .catch(() => null),
  ]);

  const containers = payloads.flatMap((payload) => toItems<Record<string, unknown>>(payload));
  const usable = containers
    .map((container) => {
      const short = container.IdShort ?? container.ID;
      const full = container.Id ?? container.ID;
      const id = typeof short === "string" && CONTAINER_ID_PATTERN.test(short) ? short : full;
      const state = String(container.State ?? container.state ?? "");
      return {
        id: typeof id === "string" && CONTAINER_ID_PATTERN.test(id) ? id : undefined,
        running: state.toLowerCase() === "running",
      };
    })
    .filter((entry): entry is { id: string; running: boolean } => entry.id !== undefined);

  return usable.find((entry) => entry.running)?.id ?? usable[0]?.id;
}