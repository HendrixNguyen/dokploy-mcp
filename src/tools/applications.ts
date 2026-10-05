/**
 * Application tools.
 *
 * Applications are the service a manager touches most: create it, point it at a repository,
 * set its environment, then deploy, restart and read logs for the rest of its life. The
 * lifecycle verbs live here rather than in discovery because each one is a separate
 * procedure with its own blast radius, and an agent that guesses between `start`, `stop`
 * and `reload` restarts the wrong thing or takes a service down.
 *
 * Three of these procedures punish an agent that fills in fields nobody asked about:
 * `saveEnvironment`, `saveBuildType` and `saveGitProvider` all require nullable fields the
 * caller may not know the value of, and `saveEnvironment` replaces the whole environment
 * rather than merging into it. Where a required field is missing, the stored value is read
 * back and echoed instead of being blanked, and the destructive one says what it is about
 * to do before it does it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clampLimit, clampOffset, humanTime, paginate, renderResult, table } from "../format.js";
import type { ApplicationSummary, Paginated } from "../types.js";
import {
  AppNameSchema,
  ConfirmSchema,
  LogTailSchema,
  PaginationSchema,
  ResponseFormatSchema,
} from "../schemas/common.js";
import { LOG_TIMEOUT_MS } from "../constants.js";
import {
  DESTRUCTIVE,
  defineTool,
  DISRUPTIVE,
  READ_ONLY,
  requireConfirmation,
  WRITE,
  type ToolContext,
  type ToolResult,
} from "./registry.js";

/* --------------------------------------------------------------- local types */

/**
 * `application.one` returns the whole application row. Dokploy's spec types every response
 * body as a bare `object` with no properties, so this declares only the fields these tools
 * read or have to echo back. The index signature keeps the untouched remainder available
 * through `structuredContent` instead of silently dropping it.
 */
interface ApplicationDetail {
  applicationId: string;
  name?: string;
  appName?: string;
  description?: string | null;
  applicationStatus?: string;
  sourceType?: string;
  buildType?: string | null;
  branch?: string | null;
  replicas?: number | null;
  autoDeploy?: boolean | null;
  rollbackActive?: boolean | null;
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
  /** Runtime environment, newline-delimited `KEY=value`. Never rendered, only counted. */
  env?: string | null;
  buildArgs?: string | null;
  /** Build-time secrets, stored in plaintext by Dokploy. Never rendered. */
  buildSecrets?: string | null;
  createEnvFile?: boolean | null;
  dockerfile?: string | null;
  dockerContextPath?: string | null;
  dockerBuildStage?: string | null;
  herokuVersion?: string | null;
  railpackVersion?: string | null;
  publishDirectory?: string | null;
  isStaticSpa?: boolean | null;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  customGitBuildPath?: string | null;
  customGitSSHKeyId?: string | null;
  watchPaths?: string[] | null;
  enableSubmodules?: boolean | null;
  serverId?: string | null;
  environmentId?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
  [key: string]: unknown;
}

/** The builder enum, exactly as `application.update` and `saveBuildType` declare it. */
const BUILD_TYPES = [
  "dockerfile",
  "heroku_buildpacks",
  "paketo_buildpacks",
  "nixpacks",
  "static",
  "railpack",
] as const;

/** `IdSchema` re-described so the generated schema names the field. */
const ApplicationIdSchema = z.string().min(1).describe("The application id");

/* ----------------------------------------------------------------- helpers */

/**
 * Dokploy makes several fields of `saveEnvironment` / `saveBuildType` / `saveGitProvider`
 * mandatory even though the caller may have no opinion about them. Sending `""` or `false`
 * for a field that was simply not mentioned would silently change it, so an omitted field
 * is answered with the value the application already stores.
 */
function fromStored<T>(provided: T | undefined, stored: T | null | undefined, empty: T): T {
  if (provided !== undefined) return provided;
  return stored === undefined || stored === null ? empty : stored;
}

/** True when at least one mandatory field is missing and the stored row has to be read. */
function isMissing(...values: unknown[]): boolean {
  return values.some((value) => value === undefined);
}

/**
 * Dokploy types every response body as a bare `object`, so a lifecycle call's payload is
 * passed through to the agent rather than interpreted. Rendered only when it carries
 * something, so an empty body does not produce a blank line.
 */
function responseLine(response: unknown): string | null {
  if (typeof response === "string") return response.length > 0 ? response : null;
  if (typeof response === "number" || typeof response === "boolean") return String(response);
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const entries = Object.entries(response as Record<string, unknown>).filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    );
    if (entries.length === 0) return null;
    return entries.map(([key, value]) => `${key}=${String(value)}`).join(" · ");
  }
  return null;
}

/** Shared result for the four lifecycle verbs, which differ only in what they ask Dokploy. */
function renderAction(applicationId: string, action: string, response: unknown): ToolResult {
  const line = responseLine(response);
  return renderResult({
    format: "markdown",
    title: `Application ${applicationId}: ${action}`,
    structured: { applicationId, action, response },
    markdown: () =>
      [
        `- **applicationId**: \`${applicationId}\``,
        `- **Action**: ${action}`,
        `- **Accepted by Dokploy**: yes`,
        ...(line ? [`- **Response**: ${line}`] : []),
      ].join("\n"),
  });
}

/** `application.deploy` answers with the new deployment's id; some builds wrap it. */
function deploymentIdOf(payload: unknown): string | null {
  if (typeof payload === "string" && payload.length > 0) return payload;
  if (typeof payload === "object" && payload !== null) {
    const id = (payload as Record<string, unknown>).deploymentId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/** `readLogs` answers with log text; a single call can carry far more than `tail` lines. */
function logLines(payload: unknown): string[] {
  if (typeof payload === "string") return payload.split("\n");
  if (Array.isArray(payload)) {
    return payload.map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
  }
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of ["logs", "log", "data"] as const) {
      if (typeof record[key] === "string" || Array.isArray(record[key])) {
        return logLines(record[key]);
      }
    }
  }
  return [];
}

/** A fence long enough that a backtick run inside a log line cannot close it early. */
function fenced(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}text\n${text}\n${ticks}`;
}

/** Counts `KEY=value` lines, ignoring blanks and comments. Secrets are counted, never shown. */
function variableCount(env: string | null | undefined): number {
  return (env ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#")).length;
}

/* ================================================================ registration */

export function registerApplications(server: McpServer, context: ToolContext): void {
  /* ------------------------------------------------------------------ search */

  defineTool(
    server,
    context,
    "dokploy_search_applications",
    {
      title: "Search Dokploy Applications",
      description: `Search applications by name, appName, description or environment, with pagination.

Narrower than \`dokploy_list_projects\`, which returns every service in the instance: this
searches only applications and can be pinned to one environment, so it is the cheapest way to
find a single app when you already know roughly what it is called.

Args:
  - q (string, optional): Free-text match across name, appName and description
  - name (string, optional): Match the display name
  - appName (string, optional): Match the container name, the name Docker and Traefik see
  - description (string, optional): Match the description
  - environmentId (string, optional): Restrict to one environment
  - projectId (string, optional): Restrict to one project
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "total": 2, "count": 2, "offset": 0, "has_more": false,
    "items": [ { "applicationId": "GZUgp4Spk…", "name": "web", "appName": "web",
                  "applicationStatus": "running", "environmentId": "3dFId8fY7…",
                  "sourceType": "github", "createdAt": "2026-01-04T09:12:00Z" } ] }

Examples:
  - Use when: "which of my apps is down?" -> { q: "web" }, then read \`applicationStatus\`
  - Use when: an app must be found in staging only ->
    { q: "api", environmentId: "3dFId8fY7…" }
  - Don't use when: you hold a name and need the id for a mutation ->
    use dokploy_resolve_service, which searches every service type at once

Error Handling:
  - No match -> an empty items array with has_more false
  - Filters are applied by Dokploy, not here, and are not substring matches: a partial value
    legitimately returns nothing, so retry with a shorter or differently spelled filter
  - An unknown environmentId or projectId yields no rows rather than an error`,
      inputSchema: z
        .object({
          q: z.string().optional().describe("Free-text match across name, appName and description"),
          name: z.string().optional().describe("Match the display name"),
          appName: z.string().optional().describe("Match the container name"),
          description: z.string().optional().describe("Match the description"),
          environmentId: z.string().optional().describe("Restrict to one environment"),
          projectId: z.string().optional().describe("Restrict to one project"),
          ...PaginationSchema,
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ q, name, appName, description, environmentId, projectId, limit, offset, response_format }): Promise<ToolResult> => {
      const size = clampLimit(limit);
      const start = clampOffset(offset);
      const payload = await context.client.query<Paginated<ApplicationSummary>>("application.search", {
        q,
        name,
        appName,
        description,
        environmentId,
        projectId,
        limit: size,
        offset: start,
      });
      const result = paginate(payload, size, start);
      const target = q ?? name ?? appName ?? description ?? "*";

      return renderResult({
        format: response_format,
        title: `Applications matching ${target} (${result.count}/${result.total})`,
        structured: result,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `No application matched ${JSON.stringify(target)}.`,
        markdown: (data) => {
          const rows = (data as { items: ApplicationSummary[] }).items.map((item) => ({
            name: item.name ?? "(unnamed)",
            applicationId: item.applicationId,
            appName: item.appName ?? "—",
            status: item.applicationStatus ?? "—",
            source: item.sourceType ?? "—",
            environmentId: item.environmentId ?? "—",
            createdAt: humanTime(item.createdAt),
          }));
          return table(rows, [
            { key: "name", label: "Application" },
            { key: "applicationId", label: "applicationId" },
            { key: "appName", label: "appName" },
            { key: "status", label: "Status" },
            { key: "source", label: "Source" },
            { key: "environmentId", label: "environmentId" },
            { key: "createdAt", label: "Created" },
          ]);
        },
      });
    },
  );

  /* --------------------------------------------------------------------- one */

  defineTool(
    server,
    context,
    "dokploy_get_application",
    {
      title: "Get One Dokploy Application",
      description: `Fetch a single application's full configuration.

Environment variables and build secrets are counted, never printed: both are stored in
plaintext in Dokploy, and a value that reaches a transcript is a leaked credential. Use this
tool to learn *how many* variables are set and to read everything that is safe to read.

Args:
  - applicationId (string, required): The application id

Returns: the application object — name, appName, status, sourceType, buildType, branch,
  resource limits, plus an \`envVariableCount\` and \`buildSecretCount\`

Examples:
  - Use when: you hold an id and need the branch, build type or replica count
  - Use when: preparing dokploy_set_application_env and you need to know what is already set
  - Don't use when: you only have a name -> use dokploy_resolve_service first
  - Don't use when: you want status, domains and recent deployments together ->
    use dokploy_describe_service, which is one call instead of three

Error Handling:
  - 404 -> no application with that id, or the id belongs to another service type
  - Secrets are withheld by design: this tool cannot show an environment value`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ applicationId }): Promise<ToolResult> => {
      const application = await context.client.query<ApplicationDetail>("application.one", {
        applicationId,
      });
      const structured = {
        ...application,
        envVariableCount: variableCount(application?.env),
        buildSecretCount: variableCount(application?.buildSecrets),
      };

      return renderResult({
        format: "markdown",
        title: `Application ${application?.name ?? applicationId}`,
        structured,
        markdown: () =>
          [
            `- **applicationId**: \`${application?.applicationId ?? applicationId}\``,
            `- **Name**: ${application?.name ?? "—"}`,
            `- **appName**: ${application?.appName ?? "—"}`,
            `- **Description**: ${application?.description || "—"}`,
            `- **Status**: ${application?.applicationStatus ?? "unknown"}`,
            `- **Source type**: ${application?.sourceType ?? "—"}`,
            `- **Build type**: ${application?.buildType ?? "—"}`,
            `- **Branch**: ${application?.branch ?? "—"}`,
            `- **Replicas**: ${application?.replicas ?? "—"}`,
            `- **Auto deploy**: ${application?.autoDeploy === true ? "yes" : "no"}`,
            `- **Rollback active**: ${application?.rollbackActive === true ? "yes" : "no"}`,
            `- **Memory limit / reservation**: ${application?.memoryLimit || "—"} / ${application?.memoryReservation || "—"}`,
            `- **CPU limit / reservation**: ${application?.cpuLimit || "—"} / ${application?.cpuReservation || "—"}`,
            `- **Server**: ${application?.serverId ?? "—"}`,
            `- **Environment**: ${application?.environmentId ?? "—"}`,
            `- **Created**: ${humanTime(application?.createdAt)}`,
            `- **Updated**: ${humanTime(application?.updatedAt)}`,
            "",
            "### Environment",
            `- **Runtime variables**: ${structured.envVariableCount} set (values withheld)`,
            `- **Build secrets**: ${structured.buildSecretCount} set (values withheld)`,
            `- **Writes a .env file at build time**: ${application?.createEnvFile === true ? "yes" : "no"}`,
            "",
            "_Environment values and build secrets are never returned by this tool. They are " +
              "stored in plaintext by Dokploy, so reading them into a transcript would leak " +
              "them. To change them, write the complete replacement through " +
              "dokploy_set_application_env._",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------------------ create */

  defineTool(
    server,
    context,
    "dokploy_create_application",
    {
      title: "Create A Dokploy Application",
      description: `Create an empty application inside an environment.

The application is created idle and with no source: a first deploy fails until a repository
is connected with \`dokploy_connect_application_git\` (or a provider-specific tool) and the
build type is set. Create it in the environment you intend to deploy to — an application
cannot be moved between environments afterwards through this tool.

Args:
  - name (string, required): Display name, shown in the Dokploy UI
  - environmentId (string, required): The environment to create it in
  - appName (string, optional): Container name, 1-63 chars of letters, digits, dot, underscore
    or hyphen. Must be unique per instance. Dokploy derives it from \`name\` when omitted.
  - description (string, optional): Free-text description
  - serverId (string, optional): Docker host to run on. Omit to use the instance's own host.
  - confirm (boolean, required): Must be true to confirm

Returns: the created application object, including its \`applicationId\`

Examples:
  - Use when: standing up a new service -> { name: "api", environmentId: "3dFId8fY7…" }
  - Use when: the container name must not change later -> pass \`appName\` explicitly
  - Don't use when: you meant a compose stack or a database -> use that service's own create
    tool, they are different resource types

Error Handling:
  - 400 -> a required field is missing or \`appName\` violates Dokploy's 1-63 character rule;
    the response names the offending field
  - 404 -> unknown environmentId or serverId
  - Nothing is deployed by this call, and no traffic is served until you deploy`,
      inputSchema: z
        .object({
          name: z.string().min(1).describe("Display name shown in the Dokploy UI"),
          environmentId: z.string().min(1).describe("The environment to create the application in"),
          appName: AppNameSchema.optional(),
          description: z.string().optional().describe("Free-text description"),
          serverId: z
            .string()
            .min(1)
            .optional()
            .describe("Docker host to run on. Omit to use the instance's own host"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async ({ name, environmentId, appName, description, serverId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This creates a new application "${name}" in environment ${environmentId}. It will be ` +
          "idle and undeployed until a source is connected.",
        "Re-run with `confirm: true` once the name and environment are right.",
      );
      if (refusal) return refusal;

      const application = await context.client.mutation<ApplicationDetail>("application.create", {
        name,
        environmentId,
        appName,
        description,
        serverId,
      });

      return renderResult({
        format: "markdown",
        title: `Created application ${application?.name ?? name}`,
        structured: { application },
        markdown: () =>
          [
            `- **applicationId**: \`${application?.applicationId ?? "(not returned)"}\``,
            `- **Name**: ${application?.name ?? name}`,
            `- **appName**: ${application?.appName ?? appName ?? "—"}`,
            `- **Environment**: ${application?.environmentId ?? environmentId}`,
            `- **Server**: ${application?.serverId ?? serverId ?? "instance host"}`,
            `- **Status**: ${application?.applicationStatus ?? "unknown"}`,
            "",
            "_Nothing is deployed yet. Connect a source with dokploy_connect_application_git, " +
              "set the environment with dokploy_set_application_env, then deploy._",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------------------ update */

  defineTool(
    server,
    context,
    "dokploy_update_application",
    {
      title: "Update A Dokploy Application",
      description: `Change an application's configuration, field by field.

Only the fields you name are sent, so everything else is left as it is. This is a partial
update over Dokploy's much larger \`application.update\` procedure, which accepts roughly a
hundred fields; the subset exposed here is the one an agent can set safely from a
conversation. Two groups are deliberately excluded:

  - \`env\` — the environment is replaced wholesale, not merged. Use
    \`dokploy_set_application_env\`, which warns about that before it overwrites anything.
  - Provider credentials and connection ids (githubId, gitlabId, bitbucketId, giteaId,
    docker registry ids, usernames and passwords). Use the provider-specific tools.

A configuration change does not deploy by itself. The new values are used by the next
\`dokploy_deploy_application\`.

Args:
  - applicationId (string, required): The application id
  - name (string, optional): New display name
  - appName (string, optional): New container name. The next deploy recreates the container
    under it, so anything addressed by the old name stops resolving.
  - description (string, optional): Description, or null to clear it
  - buildType (enum, optional): 'dockerfile' | 'heroku_buildpacks' | 'paketo_buildpacks' |
    'nixpacks' | 'static' | 'railpack'
  - branch (string, optional): Git branch to build
  - buildPath (string, optional): Subdirectory of the repository to build from
  - dockerfile (string, optional): Path to the Dockerfile
  - dockerContextPath (string, optional): Docker build context, usually "."
  - dockerBuildStage (string, optional): Stage to build from a multi-stage Dockerfile
  - dockerImage (string, optional): Image to run when the source type is "docker"
  - registryUrl (string, optional): Docker registry host, e.g. "ghcr.io"
  - registryId (string, optional): Docker credential id from the instance registry settings
  - replicas (number, optional): Replica count
  - autoDeploy (boolean, optional): Deploy on every push to \`branch\`
  - cleanCache (boolean, optional): Clear the build cache before the next build
  - rollbackActive (boolean, optional): Keep the previous image so a rollback stays possible
  - buildArgs (string, optional): Build-time arguments. These are Docker ARG values, not
    runtime environment variables
  - buildSecrets (string, optional): Build-time secrets, stored in plaintext by Dokploy
  - memoryLimit / memoryReservation (string, optional): e.g. "512m" / "256m"
  - cpuLimit / cpuReservation (string, optional): e.g. "1.0" / "0.5"
  - title / subtitle (string, optional): Labels shown in the Dokploy UI
  - publishDirectory (string, optional): Directory published for a static build
  - isStaticSpa (boolean, optional): Serve index.html for unknown paths (SPA fallback)
  - confirm (boolean, required): Must be true to confirm

Returns: the application as Dokploy stored it, and the list of fields that were written

Examples:
  - Use when: "move the app to the release branch" -> { applicationId, branch: "release" }
  - Use when: "give it 512m of memory" -> { applicationId, memoryLimit: "512m" }
  - Don't use when: you are changing environment variables ->
    use dokploy_set_application_env, which replaces the whole env and says so
  - Don't use when: you only want to publish the current state -> use
    dokploy_deploy_application, no configuration change is required

Error Handling:
  - Refuses without calling Dokploy when \`confirm\` is false, and also when no field was named
  - 400 -> the response names the offending field; a value Dokploy does not accept is
    rejected outright rather than silently ignored
  - 404 -> unknown applicationId`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          name: z.string().min(1).optional().describe("New display name"),
          appName: AppNameSchema.optional().describe("New container name"),
          description: z.string().nullish().describe("Description, or null to clear it"),
          buildType: z
            .enum(BUILD_TYPES)
            .nullish()
            .describe("Builder to use for the next build"),
          branch: z.string().nullish().describe("Git branch to build"),
          buildPath: z.string().nullish().describe("Subdirectory of the repository to build from"),
          dockerfile: z.string().nullish().describe("Path to the Dockerfile"),
          dockerContextPath: z.string().nullish().describe('Docker build context, usually "."'),
          dockerBuildStage: z
            .string()
            .nullish()
            .describe("Stage to build from a multi-stage Dockerfile"),
          dockerImage: z.string().nullish().describe('Image to run when source type is "docker"'),
          registryUrl: z.string().nullish().describe('Docker registry host, e.g. "ghcr.io"'),
          registryId: z
            .string()
            .nullish()
            .describe("Docker credential id from the instance registry settings"),
          replicas: z.number().int().optional().describe("Replica count"),
          autoDeploy: z.boolean().nullish().describe("Deploy on every push to `branch`"),
          cleanCache: z.boolean().nullish().describe("Clear the build cache before the next build"),
          rollbackActive: z
            .boolean()
            .nullish()
            .describe("Keep the previous image so a rollback stays possible"),
          buildArgs: z.string().nullish().describe("Build-time arguments (Docker ARG values)"),
          buildSecrets: z.string().nullish().describe("Build-time secrets, stored in plaintext"),
          memoryLimit: z.string().nullish().describe('Container memory limit, e.g. "512m"'),
          memoryReservation: z.string().nullish().describe('Container memory reservation, e.g. "256m"'),
          cpuLimit: z.string().nullish().describe('Container CPU limit, e.g. "1.0"'),
          cpuReservation: z.string().nullish().describe('Container CPU reservation, e.g. "0.5"'),
          title: z.string().nullish().describe("Title shown in the Dokploy UI"),
          subtitle: z.string().nullish().describe("Subtitle shown in the Dokploy UI"),
          publishDirectory: z
            .string()
            .nullish()
            .describe("Directory published for a static build"),
          isStaticSpa: z.boolean().nullish().describe("Serve index.html for unknown paths"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async (input): Promise<ToolResult> => {
      const {
        applicationId,
        name,
        appName,
        description,
        buildType,
        branch,
        buildPath,
        dockerfile,
        dockerContextPath,
        dockerBuildStage,
        dockerImage,
        registryUrl,
        registryId,
        replicas,
        autoDeploy,
        cleanCache,
        rollbackActive,
        buildArgs,
        buildSecrets,
        memoryLimit,
        memoryReservation,
        cpuLimit,
        cpuReservation,
        title,
        subtitle,
        publishDirectory,
        isStaticSpa,
        confirm,
      } = input;

      // Keys still `undefined` here are dropped by JSON.stringify, so only the fields the
      // caller named reach Dokploy. A field passed as `null` is written as null, i.e. cleared.
      const changes: Record<string, unknown> = {
        name,
        appName,
        description,
        buildType,
        branch,
        buildPath,
        dockerfile,
        dockerContextPath,
        dockerBuildStage,
        dockerImage,
        registryUrl,
        registryId,
        replicas,
        autoDeploy,
        cleanCache,
        rollbackActive,
        buildArgs,
        buildSecrets,
        memoryLimit,
        memoryReservation,
        cpuLimit,
        cpuReservation,
        title,
        subtitle,
        publishDirectory,
        isStaticSpa,
      };
      const changed = Object.keys(changes).filter((key) => changes[key] !== undefined);

      if (changed.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Error: nothing to update. Name at least one field to change — for example " +
                "`branch`, `buildType`, `memoryLimit` or `replicas` — or use " +
                "dokploy_deploy_application if you only want to publish the current state. " +
                "No request was sent to Dokploy.",
            },
          ],
        };
      }

      const refusal = requireConfirmation(
        confirm,
        `This writes ${changed.join(", ")} on application ${applicationId}. The change takes ` +
          "effect on the next deploy, not immediately.",
        `Re-run with \`confirm: true\` and these fields: ${changed.join(", ")}.`,
      );
      if (refusal) return refusal;

      const application = await context.client.mutation<ApplicationDetail>("application.update", {
        applicationId,
        ...changes,
      });

      return renderResult({
        format: "markdown",
        title: `Updated application ${application?.name ?? applicationId}`,
        structured: { application, changed },
        markdown: () =>
          [
            `- **applicationId**: \`${application?.applicationId ?? applicationId}\``,
            `- **Name**: ${application?.name ?? "—"}`,
            `- **Fields written**: ${changed.join(", ")}`,
            `- **Status**: ${application?.applicationStatus ?? "unknown"}`,
            "",
            "_Configuration changed but not deployed. Run dokploy_deploy_application to " +
              "publish it._",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------------------ deploy */

  defineTool(
    server,
    context,
    "dokploy_deploy_application",
    {
      title: "Deploy A Dokploy Application",
      description: `Build the application's current configuration and deploy it.

The call returns as soon as Dokploy has accepted the build; the build itself runs in the
background and takes minutes. The returned \`deploymentId\` identifies that run, so keep it:
it is what a build log is filed under. A failed build leaves the currently running release
untouched, so a deploy is the safe way to try a change.

Args:
  - applicationId (string, required): The application id
  - title (string, optional): Label for this deployment, shown in the deployment list
  - description (string, optional): Free-text note for this deployment
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "deploymentId": "kQ2mXd81Vr…" }

Examples:
  - Use when: "deploy the API" -> { applicationId, confirm: true }
  - Use when: shipping a known-good state -> name the release in \`title\` so it is findable
  - Don't use when: the container is running the wrong image and needs a restart ->
    use dokploy_reload_application, which restarts without rebuilding

Error Handling:
  - 404 -> unknown applicationId
  - The build fails *after* this call returns, so a successful response here is not a
    successful deployment: check the deployment's status before assuming the change is live
  - An application with no connected source or no build type fails at the build step`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          title: z.string().optional().describe("Label for this deployment"),
          description: z.string().optional().describe("Free-text note for this deployment"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async ({ applicationId, title, description, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This builds and deploys application ${applicationId}, replacing whatever is running ` +
          "once the build succeeds. The build runs in the background after this call returns.",
        "Re-run with `confirm: true` when the repository is in the state you intend to ship.",
      );
      if (refusal) return refusal;

      const payload = await context.client.mutation<unknown>("application.deploy", {
        applicationId,
        title,
        description,
      });
      const deploymentId = deploymentIdOf(payload);
      const structured = { applicationId, deploymentId, response: payload };

      return renderResult({
        format: "markdown",
        title: `Deployment queued for ${applicationId}`,
        structured,
        markdown: () =>
          [
            `- **applicationId**: \`${applicationId}\``,
            `- **deploymentId**: ${deploymentId ? `\`${deploymentId}\`` : "(not returned by Dokploy)"}`,
            `- **Title**: ${title || "—"}`,
            "",
            "_The build is running in the background. A queued deployment is not a successful " +
              "one: read the deployment's status and its build log before treating the change " +
              "as live._",
          ].join("\n"),
      });
    },
  );

  /* -------------------------------------------------------- lifecycle verbs */

  defineTool(
    server,
    context,
    "dokploy_start_application",
    {
      title: "Start A Dokploy Application",
      description: `Start a stopped application's container on its existing configuration.

Nothing is rebuilt and no configuration is read from the repository: the previously built
image is started as it was. Use this to bring a service back after
\`dokploy_stop_application\`.

Args:
  - applicationId (string, required): The application id
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "action": "started" }

Examples:
  - Use when: "bring the API back up" after a planned stop
  - Don't use when: new code should be published ->
    use dokploy_deploy_application, which builds first
  - Don't use when: the container runs but serves errors -> use dokploy_reload_application
    to replace it from the built image

Error Handling:
  - 404 -> unknown applicationId
  - Starting does not make the service healthy: a bad configuration or a failed health
    check leaves it starting or restarting, which is what \`dokploy_get_application\` reports`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async ({ applicationId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This starts the container for application ${applicationId} on its existing image.`,
        "Re-run with `confirm: true` when the service is meant to be up.",
      );
      if (refusal) return refusal;

      const response = await context.client.mutation<unknown>("application.start", { applicationId });
      return renderAction(applicationId, "started", response);
    },
  );

  defineTool(
    server,
    context,
    "dokploy_stop_application",
    {
      title: "Stop A Dokploy Application",
      description: `Stop a running application's container. Nothing is destroyed and nothing is rebuilt.

The container is removed from the running set, so every request to its domains fails until it
is started again. Configuration, the built image and the deployment history are all kept, and
\`dokploy_start_application\` brings it back on the same image.

Args:
  - applicationId (string, required): The application id
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "action": "stopped" }

Examples:
  - Use when: a maintenance window, or while a host is being drained
  - Use when: a runaway container is consuming the host and must be stopped now
  - Don't use when: you want the application gone for good ->
    use dokploy_delete_application
  - Don't use when: the container should be replaced by a new build ->
    use dokploy_deploy_application, which replaces it without an outage

Error Handling:
  - 404 -> unknown applicationId
  - A stopped application still answers \`dokploy_get_application\`; only its status and the
    reachability of its domains change`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DISRUPTIVE,
    },
    async ({ applicationId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This stops the running container for application ${applicationId}. Requests to its ` +
          "domains will fail until it is started again.",
        "Re-run with `confirm: true` when the outage is intended, or use " +
          "dokploy_deploy_application if you meant to publish a new build.",
      );
      if (refusal) return refusal;

      const response = await context.client.mutation<unknown>("application.stop", { applicationId });
      return renderAction(applicationId, "stopped", response);
    },
  );

  defineTool(
    server,
    context,
    "dokploy_reload_application",
    {
      title: "Restart A Dokploy Application In Place",
      description: `Recreate the container from the image that is already built.

A reload is a restart, not a rebuild: it does not read the repository and does not change the
configuration. In-flight requests are dropped while the container is replaced, so it is a
brief outage rather than a rolling one.

Dokploy's \`application.reload\` requires both the application id and the container name, so
when \`appName\` is omitted this tool reads it from the application rather than guessing it.

Args:
  - applicationId (string, required): The application id
  - appName (string, optional): The container name. Read from the application when omitted.
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "action": "reloaded" }

Examples:
  - Use when: a container is wedged and a restart would clear it
  - Use when: a mounted secret or host change only takes effect on a fresh container
  - Don't use when: new code must be published ->
    use dokploy_deploy_application, which rebuilds first
  - Don't use when: the application should stay up and a rolling replacement would do ->
    a deploy is the better tool

Error Handling:
  - 404 -> unknown applicationId, or a stale \`appName\` no longer matching the container
  - Omitting \`appName\` costs one extra read; passing a wrong one fails the call`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          appName: z
            .string()
            .min(1)
            .optional()
            .describe("The container name. Read from the application when omitted"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DISRUPTIVE,
    },
    async ({ applicationId, appName, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This restarts the container of application ${applicationId} in place. In-flight ` +
          "requests are dropped and there is a short outage while the container is replaced.",
        "Re-run with `confirm: true` when a brief outage is acceptable, or use " +
          "dokploy_deploy_application to publish a new build instead.",
      );
      if (refusal) return refusal;

      // `reload` is the one procedure here that needs a field the caller may not hold.
      const resolvedAppName =
        appName ??
        (await context.client.query<ApplicationDetail>("application.one", { applicationId }))
          .appName;
      if (!resolvedAppName) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Error: application ${applicationId} has no appName, and application.reload ` +
                "requires one. Pass `appName` explicitly. No request was sent to Dokploy.",
            },
          ],
        };
      }

      const response = await context.client.mutation<unknown>("application.reload", {
        applicationId,
        appName: resolvedAppName,
      });
      return renderAction(applicationId, "reloaded", response);
    },
  );

  defineTool(
    server,
    context,
    "dokploy_cancel_application_deployment",
    {
      title: "Cancel An Application's In-Flight Deployment",
      description: `Kill the build or deploy currently running for an application.

This is the tool for a deployment that is stuck, looping or filling the disk. Only the
in-flight attempt is abandoned: the release that is running now keeps running and its
configuration is unchanged, so cancelling is the low-risk half of "stop this deploy".

The application is left in whatever state the cancelled run had reached. It does not return
to a previous image — use a rollback for that.

Args:
  - applicationId (string, required): The application id
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "action": "cancelled" }

Examples:
  - Use when: a build has run far longer than it ever has and should be abandoned
  - Use when: the wrong commit was pushed and the deploy must not finish
  - Don't use when: the new build succeeded but is the wrong version ->
    cancelling cannot undo a completed deployment
  - Don't use when: nothing is in flight -> this is a no-op on a finished deployment

Error Handling:
  - 404 -> unknown applicationId
  - The running release is not rolled back by this call; a deployment that already finished
    is unaffected, and a partially built image is left behind for the next build to reuse`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async ({ applicationId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This kills the deployment currently in flight for application ${applicationId}. The ` +
          "running release keeps running, but the attempt is abandoned part-way and cannot be " +
          "resumed.",
        "Re-run with `confirm: true` once you have confirmed a deployment really is in flight, " +
          "using dokploy_describe_service to see its recent deployments.",
      );
      if (refusal) return refusal;

      const response = await context.client.mutation<unknown>("application.cancelDeployment", {
        applicationId,
      });
      return renderAction(applicationId, "cancelled", response);
    },
  );

  /* ------------------------------------------------------------------ delete */

  defineTool(
    server,
    context,
    "dokploy_delete_application",
    {
      title: "Delete A Dokploy Application",
      description: `Remove an application from the instance, permanently.

This deletes the application record, its container, its domains and its deployment history in
one call. It cannot be undone from Dokploy. The git repository it was built from is not
touched, so the code survives, but the Dokploy configuration does not and has to be rebuilt
from scratch — there is no export.

Anything outside the containers Dokploy manages is left alone: a bind-mounted directory on
the Docker host, an external volume, and the repository itself are all still there.

Args:
  - applicationId (string, required): The application id
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "action": "deleted" }

Examples:
  - Use when: a service has been retired and its record should go
  - Use when: the same name has to be reused by a different application
  - Don't use when: the configuration must be kept but the service taken offline ->
    use dokploy_stop_application, which is reversible
  - Don't use when: you are unsure whether the id is the right one ->
    check it with dokploy_get_application first; a wrong id deletes a real application

Error Handling:
  - 404 -> no application with that id, so nothing was deleted
  - Deleting while a deployment is in flight leaves that build running to completion
    against a removed application: cancel it first with
    dokploy_cancel_application_deployment`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async ({ applicationId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This permanently deletes application ${applicationId} from the instance, together ` +
          "with its container, its domains and its deployment history. It cannot be undone " +
          "from Dokploy; the repository itself is untouched.",
        "Re-run with `confirm: true` only if this application is meant to be removed. To " +
          "recover afterwards, recreate it with dokploy_create_application and repeat the " +
          "configuration steps — read them out first with dokploy_get_application.",
      );
      if (refusal) return refusal;

      const response = await context.client.mutation<unknown>("application.delete", {
        applicationId,
      });
      return renderAction(applicationId, "deleted", response);
    },
  );

  /* ------------------------------------------------------------------- logs */

  defineTool(
    server,
    context,
    "dokploy_get_application_logs",
    {
      title: "Read A Dokploy Application's Logs",
      description: `Read the tail of an application's container logs.

The line budget here is deliberately larger than anywhere else in this server: \`tail\`
defaults to 200 lines instead of 20, and rises to 10000, because a log is the largest
unbounded response in the API and a diagnosis rarely fits in twenty lines. The response is
still capped by the server's own character limit — a larger tail that overflows is truncated
with a note, not silently cut.

The most recent lines are kept and older ones dropped, so a returned block ends at "now".
Logs belong to the running container, not to a deployment: a failed build writes to that
build's own log, not here.

Args:
  - applicationId (string, required): The application id
  - tail (number, optional): 1-10000, default 200. Most recent lines to return.
  - since (string, optional): Only lines newer than this window — '30s', '15m', '6h', '2d',
    or 'all' (the server's default) for everything
  - search (string, optional): Only lines containing this substring. Dokploy accepts
    letters, digits, spaces, dots, underscores and hyphens only.
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "applicationId": "GZUgp4Spk…", "tail": 200, "since": "all", "dropped": 0,
    "lineCount": 200, "lines": ["…", "…"] }

Examples:
  - Use when: "the API is returning 502" -> { applicationId, tail: 200 }
  - Use when: an error appeared in the last ten minutes ->
    { applicationId, since: "10m", search: "Error" }
  - Don't use when: a build or deploy failed -> that log belongs to the deployment, and the
    deploymentId from dokploy_deploy_application identifies it
  - Don't use when: the default tail has not been read yet -> raise \`tail\` once, rather
    than calling repeatedly; the API key has a refill-based quota

Error Handling:
  - 404 -> unknown applicationId
  - An application that has never run has no logs: an empty array and \`dropped: 0\`, not
    an error
  - A \`search\` or \`since\` value outside Dokploy's accepted pattern is rejected with the
    offending value named`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          ...LogTailSchema,
          since: z
            .string()
            .regex(/^(all|\d+[smhd])$/, "Use 'all', or a window like '30s', '15m', '6h', '2d'")
            .optional()
            .describe("Only lines newer than this window. 'all' for everything"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ applicationId, tail, since, search, response_format }): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>(
        "application.readLogs",
        { applicationId, tail, since, search },
        { timeoutMs: LOG_TIMEOUT_MS },
      );

      const all = logLines(payload);
      // Keep the most recent `tail` lines: in a container log the last line is the newest.
      const lines = all.length > tail ? all.slice(all.length - tail) : all;
      const structured = {
        applicationId,
        tail,
        since: since ?? "all",
        search: search ?? null,
        lineCount: lines.length,
        dropped: all.length - lines.length,
        lines,
      };

      return renderResult({
        format: response_format,
        title: `Logs for ${applicationId} (${lines.length} line${lines.length === 1 ? "" : "s"})`,
        structured,
        isEmpty: (data) => (data as { lines: unknown[] }).lines.length === 0,
        empty:
          `Application ${applicationId} has produced no log lines` +
          `${since ? ` since ${since}` : ""}. It may never have run, or its logs were ` +
          "cleared by a restart.",
        markdown: (data) => {
          const page = data as { lines: string[]; dropped: number; tail: number };
          const header =
            page.dropped > 0
              ? `_Dropped ${page.dropped} older line${page.dropped === 1 ? "" : "s"} to fit ` +
                `the requested tail of ${page.tail}._\n\n`
              : "";
          return `${header}${fenced(page.lines.join("\n"))}`;
        },
      });
    },
  );

  /* ------------------------------------------------------------------- env */

  defineTool(
    server,
    context,
    "dokploy_set_application_env",
    {
      title: "Replace A Dokploy Application's Environment",
      description: `Set an application's runtime environment, build arguments and build secrets.

**This replaces the whole environment.** Dokploy merges nothing: a variable that is not in
the \`env\` you send is gone from the application's configuration afterwards, and the
replacement takes effect on the next deploy or restart. The value to send is therefore the
complete desired state, not a patch. \`env: ""\` clears every variable.

Variables the caller did not mention are read back from the application and echoed
unchanged, so an omitted \`buildArgs\` never silently wipes the build arguments.

All four fields are stored in plaintext by Dokploy. Nothing here is echoed back in the
response.

Args:
  - applicationId (string, required): The application id
  - env (string, required): The complete runtime environment, newline-delimited
    \`KEY=value\`. This is the full replacement, not a diff. \`""\` clears it.
  - buildArgs (string, optional): Build-time arguments, newline-delimited. Kept as stored when
    omitted.
  - buildSecrets (string, optional): Build-time secrets, newline-delimited. Kept as stored
    when omitted. Never echoed back.
  - createEnvFile (boolean, optional): Write the environment to a \`.env\` file in the build
    context. Kept as stored when omitted.
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "envVariableCount": 12, "buildSecretCount": 2,
    "createEnvFile": true, "echoedFromStored": ["buildArgs", "buildSecrets"] }

Examples:
  - Use when: adding a variable to an application that already has some ->
    read the current set with dokploy_get_application first, then send every variable you
    want kept plus the new one
  - Use when: rotating one secret -> include all other variables unchanged in the same call
  - Don't use when: only build behaviour changes ->
    use dokploy_update_application, which patches single fields
  - Don't use when: you want to inspect the variables ->
    dokploy_get_application reports how many are set without revealing any

Error Handling:
  - Refuses without calling Dokploy while \`confirm\` is false, and the refusal states that
    the whole environment is at stake
  - 400 -> a line that is not \`KEY=value\` is rejected and the offending value is named
  - The new environment is stored immediately but the running container keeps the old one
    until the next deploy or restart`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          env: z
            .string()
            .describe(
              "The COMPLETE runtime environment as newline-delimited KEY=value pairs. " +
                "Anything missing from this string is removed from the application.",
            ),
          buildArgs: z
            .string()
            .optional()
            .describe("Build-time arguments. Kept as stored when omitted"),
          buildSecrets: z
            .string()
            .optional()
            .describe("Build-time secrets. Kept as stored when omitted, never echoed back"),
          createEnvFile: z
            .boolean()
            .optional()
            .describe("Write a .env file in the build context. Kept as stored when omitted"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async ({ applicationId, env, buildArgs, buildSecrets, createEnvFile, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This REPLACES the entire stored environment of application ${applicationId}. Every ` +
          "variable not present in `env` afterwards is removed from the application's " +
          "configuration, and the replacement only takes effect on the next deploy or restart.",
        "Call dokploy_get_application to see how many variables are currently set, include " +
          "every variable you still want in `env`, then re-run with `confirm: true`. Read the " +
          "values from the repository's own env file or secret store — this server will not " +
          "print them for you.",
      );
      if (refusal) return refusal;

      // Three of the four fields are mandatory in the API whether or not the caller has an
      // opinion about them, so an omitted one is answered from the stored row.
      const echoed = [
        buildArgs === undefined ? "buildArgs" : null,
        buildSecrets === undefined ? "buildSecrets" : null,
        createEnvFile === undefined ? "createEnvFile" : null,
      ].filter((key): key is string => key !== null);
      const stored =
        echoed.length > 0
          ? await context.client.query<ApplicationDetail>("application.one", { applicationId })
          : null;

      const nextBuildArgs = fromStored(buildArgs, stored?.buildArgs, "");
      const nextBuildSecrets = fromStored(buildSecrets, stored?.buildSecrets, "");
      const nextCreateEnvFile = fromStored(createEnvFile, stored?.createEnvFile, false);

      await context.client.mutation<unknown>("application.saveEnvironment", {
        applicationId,
        env,
        buildArgs: nextBuildArgs,
        buildSecrets: nextBuildSecrets,
        createEnvFile: nextCreateEnvFile,
      });

      const structured = {
        applicationId,
        envVariableCount: variableCount(env),
        buildSecretCount: variableCount(nextBuildSecrets),
        createEnvFile: nextCreateEnvFile,
        echoedFromStored: echoed,
      };

      return renderResult({
        format: "markdown",
        title: `Environment replaced for ${applicationId}`,
        structured,
        markdown: () =>
          [
            `- **applicationId**: \`${applicationId}\``,
            `- **Runtime variables**: ${structured.envVariableCount} (values withheld)`,
            `- **Build secrets**: ${structured.buildSecretCount} (values withheld)`,
            `- **Writes a .env file**: ${structured.createEnvFile ? "yes" : "no"}`,
            `- **Kept from the stored value**: ${echoed.length > 0 ? echoed.join(", ") : "none — every field was supplied"}`,
            "",
            "_The stored environment has been replaced. Variables that were set before and " +
              "are not in the new value are gone. The running container still has the old " +
              "environment until the next deploy or restart._",
          ].join("\n"),
      });
    },
  );

  /* -------------------------------------------------------------- build type */

  defineTool(
    server,
    context,
    "dokploy_set_application_build_type",
    {
      title: "Set A Dokploy Application's Build Type",
      description: `Choose how an application is built: Dockerfile, buildpacks, nixpacks, static or railpack.

Dokploy requires the fields belonging to the other builders as well, so the ones you do not
mention are read back from the application and echoed unchanged rather than blanked.

Changing the builder does not rebuild anything. The next
\`dokploy_deploy_application\` produces a completely different image, which is why this is
worth pairing with a rollback-capable configuration.

Args:
  - applicationId (string, required): The application id
  - buildType (enum, required): 'dockerfile' | 'heroku_buildpacks' | 'paketo_buildpacks' |
    'nixpacks' | 'static' | 'railpack'
  - dockerfile (string, optional): Path to the Dockerfile. Kept as stored when omitted.
  - dockerContextPath (string, optional): Docker build context, usually ".". Kept as stored
    when omitted.
  - dockerBuildStage (string, optional): Stage to build from a multi-stage Dockerfile. Kept
    as stored when omitted.
  - herokuVersion (string, optional): Heroku buildpack version, e.g. "1.0.4". Kept as stored
    when omitted.
  - railpackVersion (string, optional): Railpack version. Kept as stored when omitted.
  - publishDirectory (string, optional): Directory published for 'static'. Defaults to
    "public" server-side when omitted.
  - isStaticSpa (boolean, optional): Serve index.html for unknown paths, so client-side
    routes work. Kept as stored when omitted.
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "buildType": "nixpacks", "echoedFromStored":
    ["dockerfile", "dockerContextPath", "dockerBuildStage", "herokuVersion", "railpackVersion"] }

Examples:
  - Use when: "build it with nixpacks" -> { applicationId, buildType: "nixpacks" }
  - Use when: a static site needs a publish directory ->
    { applicationId, buildType: "static", publishDirectory: "dist", isStaticSpa: true }
  - Don't use when: a Dockerfile build already works and only a path is wrong ->
    use dokploy_update_application, which patches the path on its own

Error Handling:
  - 400 -> \`buildType\` outside the enum, or a field Dokploy rejects for the chosen builder
  - A build type that does not match the repository fails at the next deploy, not here`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          buildType: z.enum(BUILD_TYPES).describe("Builder to use for the next build"),
          dockerfile: z.string().optional().describe("Path to the Dockerfile"),
          dockerContextPath: z.string().optional().describe('Docker build context, usually "."'),
          dockerBuildStage: z
            .string()
            .optional()
            .describe("Stage to build from a multi-stage Dockerfile"),
          herokuVersion: z.string().optional().describe("Heroku buildpack version, e.g. \"1.0.4\""),
          railpackVersion: z.string().optional().describe("Railpack version"),
          publishDirectory: z.string().optional().describe("Directory published for 'static'"),
          isStaticSpa: z
            .boolean()
            .optional()
            .describe("Serve index.html for unknown paths (SPA fallback)"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async ({
      applicationId,
      buildType,
      dockerfile,
      dockerContextPath,
      dockerBuildStage,
      herokuVersion,
      railpackVersion,
      publishDirectory,
      isStaticSpa,
      confirm,
    }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This switches application ${applicationId} to the ${buildType} builder. The next ` +
          "deploy produces a different image from the same repository, and it can fail there.",
        "Re-run with `confirm: true` once you have checked the repository matches this " +
          "builder.",
      );
      if (refusal) return refusal;

      // The API requires every builder's fields, so an omitted one is answered from storage.
      const echoed = [
        dockerfile === undefined ? "dockerfile" : null,
        dockerContextPath === undefined ? "dockerContextPath" : null,
        dockerBuildStage === undefined ? "dockerBuildStage" : null,
        herokuVersion === undefined ? "herokuVersion" : null,
        railpackVersion === undefined ? "railpackVersion" : null,
        isStaticSpa === undefined ? "isStaticSpa" : null,
      ].filter((key): key is string => key !== null);
      const stored =
        echoed.length > 0
          ? await context.client.query<ApplicationDetail>("application.one", { applicationId })
          : null;

      await context.client.mutation<unknown>("application.saveBuildType", {
        applicationId,
        buildType,
        dockerfile: fromStored(dockerfile, stored?.dockerfile, null),
        dockerContextPath: fromStored(dockerContextPath, stored?.dockerContextPath, null),
        dockerBuildStage: fromStored(dockerBuildStage, stored?.dockerBuildStage, null),
        herokuVersion: fromStored(herokuVersion, stored?.herokuVersion, null),
        railpackVersion: fromStored(railpackVersion, stored?.railpackVersion, null),
        publishDirectory: fromStored(publishDirectory, stored?.publishDirectory, null),
        isStaticSpa: fromStored(isStaticSpa, stored?.isStaticSpa, null),
      });

      const structured = { applicationId, buildType, echoedFromStored: echoed };
      return renderResult({
        format: "markdown",
        title: `Build type for ${applicationId} set to ${buildType}`,
        structured,
        markdown: () =>
          [
            `- **applicationId**: \`${applicationId}\``,
            `- **buildType**: ${buildType}`,
            `- **Kept from the stored value**: ${echoed.length > 0 ? echoed.join(", ") : "none — every field was supplied"}`,
            "",
            "_No build was run. Deploy with dokploy_deploy_application to produce an image " +
              "with this builder._",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------------ git provider */

  defineTool(
    server,
    context,
    "dokploy_connect_application_git",
    {
      title: "Point A Dokploy Application At A Git Repository",
      description: `Connect an application to a plain Git repository over HTTPS or SSH.

This is Dokploy's generic \`git\` source: a URL, a branch and a build path. It is the right
tool for a self-hosted Gitea, a bare repository, or any host Dokploy has no dedicated
provider for. For github.com, gitlab.com or bitbucket.org prefer the provider-specific
tools, which also store the access token.

Calling this replaces whatever source the application had. A GitHub or GitLab connection
configured earlier is overwritten by these values, and the next deploy builds from this URL
instead.

Fields you do not mention are read back from the application and echoed unchanged, so an
omitted \`watchPaths\` never clears the paths the application was watching.

Args:
  - applicationId (string, required): The application id
  - customGitUrl (string, required): Repository URL, e.g. "https://git.example.com/app/api.git"
  - customGitBranch (string, required): Branch to build, e.g. "main"
  - customGitBuildPath (string, optional): Subdirectory to build from. Defaults to the
    repository root. Kept as stored when omitted.
  - watchPaths (string array, optional): Subdirectories that trigger a rebuild. Kept as
    stored when omitted.
  - customGitSSHKeyId (string, optional): SSH key id from the instance's SSH keys, for an
    \`git@\` URL. Kept as stored when omitted.
  - enableSubmodules (boolean, optional): Clone git submodules during the build. Kept as
    stored when omitted.
  - confirm (boolean, required): Must be true to confirm

Returns:
  { "applicationId": "GZUgp4Spk…", "customGitUrl": "https://…", "customGitBranch": "main",
    "watchPaths": ["apps/api"], "echoedFromStored": ["watchPaths"] }

Examples:
  - Use when: an app must build from a repository on a self-hosted Gitea ->
    { applicationId, customGitUrl: "https://gitea.example.com/team/api.git",
      customGitBranch: "main" }
  - Use when: only the frontend should trigger a rebuild -> pass \`watchPaths\`
  - Don't use when: the repository is on github.com, gitlab.com or bitbucket.org ->
    use that provider's tool, which also stores credentials
  - Don't use when: nothing about the source should change -> this is not a no-op call

Error Handling:
  - 404 -> unknown applicationId
  - A wrong URL or an inaccessible private repository fails at the next deploy with an
    authentication or clone error, not here
  - 400 -> a value Dokploy rejects; \`customGitBranch\` must be a non-empty string`,
      inputSchema: z
        .object({
          applicationId: ApplicationIdSchema,
          customGitUrl: z
            .string()
            .min(1)
            .describe('Repository URL, e.g. "https://git.example.com/team/api.git"'),
          customGitBranch: z.string().min(1).describe('Branch to build, e.g. "main"'),
          customGitBuildPath: z
            .string()
            .optional()
            .describe("Subdirectory to build from. Defaults to the repository root"),
          watchPaths: z
            .array(z.string())
            .optional()
            .describe("Subdirectories that trigger a rebuild"),
          customGitSSHKeyId: z
            .string()
            .optional()
            .describe("SSH key id from the instance's SSH keys, for a git@ URL"),
          enableSubmodules: z.boolean().optional().describe("Clone git submodules during the build"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async ({
      applicationId,
      customGitUrl,
      customGitBranch,
      customGitBuildPath,
      watchPaths,
      customGitSSHKeyId,
      enableSubmodules,
      confirm,
    }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `This points application ${applicationId} at ${customGitUrl} on branch ` +
          `${customGitBranch}, replacing the source it is currently configured with. The next ` +
          "deploy builds from that URL.",
        "Re-run with `confirm: true` once the URL and branch are right. If this application " +
          "is on GitHub or GitLab, use that provider's tool instead so the credentials are " +
          "stored too.",
      );
      if (refusal) return refusal;

      // The API requires build path, watch paths and branch even when the caller has no
      // opinion, so an omitted one is answered from the stored row.
      const echoed = [
        customGitBuildPath === undefined ? "customGitBuildPath" : null,
        watchPaths === undefined ? "watchPaths" : null,
        customGitSSHKeyId === undefined ? "customGitSSHKeyId" : null,
        enableSubmodules === undefined ? "enableSubmodules" : null,
      ].filter((key): key is string => key !== null);
      const stored =
        echoed.length > 0
          ? await context.client.query<ApplicationDetail>("application.one", { applicationId })
          : null;

      await context.client.mutation<unknown>("application.saveGitProvider", {
        applicationId,
        customGitUrl,
        customGitBranch,
        customGitBuildPath: fromStored(customGitBuildPath, stored?.customGitBuildPath, null),
        watchPaths: fromStored(watchPaths, stored?.watchPaths, null),
        customGitSSHKeyId: fromStored(customGitSSHKeyId, stored?.customGitSSHKeyId, null),
        enableSubmodules: fromStored(enableSubmodules, stored?.enableSubmodules, null),
      });

      const nextWatchPaths = fromStored(watchPaths, stored?.watchPaths, null);
      const structured = {
        applicationId,
        customGitUrl,
        customGitBranch,
        watchPaths: nextWatchPaths,
        echoedFromStored: echoed,
      };

      return renderResult({
        format: "markdown",
        title: `Git source set for ${applicationId}`,
        structured,
        markdown: () =>
          [
            `- **applicationId**: \`${applicationId}\``,
            `- **Repository**: ${customGitUrl}`,
            `- **Branch**: ${customGitBranch}`,
            `- **Watch paths**: ${Array.isArray(nextWatchPaths) && nextWatchPaths.length > 0 ? nextWatchPaths.join(", ") : "—"}`,
            `- **Kept from the stored value**: ${echoed.length > 0 ? echoed.join(", ") : "none — every field was supplied"}`,
            "",
            "_The source is stored but nothing was built. Deploy with " +
              "dokploy_deploy_application to fetch this repository._",
          ].join("\n"),
      });
    },
  );
}
