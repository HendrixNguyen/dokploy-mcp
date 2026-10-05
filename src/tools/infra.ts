/**
 * Infrastructure tools: mounts, registries, SSH keys, Docker networks, cluster nodes,
 * audit logs, notification channels and git providers.
 *
 * None of these are Dokploy services. They are the substrate a service sits on, and an agent
 * debugging "why does my deploy fail?" needs them: the missing bind mount, the private
 * registry that cannot authenticate, the SSH key compose cannot clone with, the branch that
 * does not exist.
 *
 * Reads are cheap and broad. Only the two mount mutations are gated, because a mount removed
 * by mistake takes a running service's data with it.
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
  DESTRUCTIVE,
  DISRUPTIVE,
  READ_ONLY,
  requireConfirmation,
  type ToolContext,
  type ToolResult,
} from "./registry.js";

/**
 * Dokploy declares every 200 body as a bare `object`, so a list arrives either as an array
 * or wrapped in `{ items }`. `pick` then reads fields defensively: the exact key names are
 * not part of the pinned spec, so a missing one renders as `—` instead of being invented.
 */
function toItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value;
  }
  const lower = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const actual = lower.get(key.toLowerCase());
    if (actual !== undefined) {
      const value = row[actual];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function text(row: Record<string, unknown>, ...keys: string[]): string {
  const value = pick(row, ...keys);
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Fields every list tool here shares, so the responses line up in a transcript. */
const COMMON_COLUMNS = [
  { key: "name", label: "Name" },
  { key: "id", label: "Id" },
  { key: "detail", label: "Detail" },
  { key: "createdAt", label: "Created" },
] as const;

type GitProvider = "github" | "gitlab" | "gitea" | "bitbucket";

/**
 * Each provider's branch-listing procedure and the name of its configured-account
 * argument. Kept in one place so the discriminated union and the request it builds cannot
 * disagree about which provider owns which parameter.
 */
const PROVIDERS: Record<GitProvider, { procedure: string; accountKey: string }> = {
  github: { procedure: "github.getGithubBranches", accountKey: "githubId" },
  gitlab: { procedure: "gitlab.getGitlabBranches", accountKey: "gitlabId" },
  gitea: { procedure: "gitea.getGiteaBranches", accountKey: "giteaId" },
  bitbucket: { procedure: "bitbucket.getBitbucketBranches", accountKey: "bitbucketId" },
};

export function registerInfra(server: McpServer, context: ToolContext): void {
  /* --------------------------------------------------------------- mounts */

  defineTool(
    server,
    context,
    "dokploy_list_mounts",
    {
      title: "List Mounts On An Application",
      description: `List the bind mounts, named volumes and file mounts attached to an application.

Dokploy only exposes this list per application, so an applicationId is required. A stack
without its expected mount is the usual reason a container starts and then immediately
exits.

Args:
  - applicationId (string, required): The application to list mounts for

Returns:
  { "items": [ { "mountId": "…", "mountPath": "/data", "type": "bind",
                 "hostPath": "/srv/uploads", "serviceType": "application" } ],
    "total": 2 }

Examples:
  - Use when: "where does the upload directory come from?" -> read \`hostPath\`
  - Use when: a container exits on start -> check the mount paths still exist
  - Don't use when: you have a compose or database id -> this procedure takes an
    applicationId only; use dokploy_list_containers to see the resulting mounts

Error Handling:
  - 404 -> no application with that id`,
      inputSchema: z
        .object({
          applicationId: IdSchema.describe("The application to list mounts for"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>(
        "mounts.allNamedByApplicationId",
        { applicationId: input.applicationId },
      );
      const items = toItems<Record<string, unknown>>(payload);
      const rows = items.map((mount) => ({
        name: text(mount, "mountPath"),
        id: text(mount, "mountId"),
        type: text(mount, "type"),
        source: text(mount, "hostPath", "volumeName", "content"),
        serviceType: text(mount, "serviceType"),
        serviceId: text(mount, "serviceId"),
      }));
      const structured = { items: rows, total: items.length, applicationId: input.applicationId };

      return renderResult({
        format: "markdown",
        title: `Mounts on ${input.applicationId} (${rows.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `Application ${input.applicationId} has no mounts. It sees only the container filesystem.`,
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [
            { key: "name", label: "Mount path" },
            { key: "id", label: "mountId" },
            { key: "type", label: "Type" },
            { key: "source", label: "Source" },
            { key: "serviceType", label: "Service type" },
            { key: "serviceId", label: "Service id" },
          ]),
      });
    },
  );

  /**
   * `mounts.create` takes one body whose shape depends on `type`: a bind needs a host path,
   * a volume needs a volume name, a file needs the file's content. Modelling that as three
   * optional fields would let a `volume` mount be created with a `hostPath`, which Docker
   * accepts and Dokploy then silently mis-mounts — so the union makes the pairing a type
   * error rather than a runtime surprise.
   */
  const mountCommon = {
    mountPath: z
      .string()
      .min(1)
      .describe("Absolute path inside the container where the mount appears"),
    serviceId: IdSchema.describe("The service the mount is attached to"),
    serviceType: z
      .enum(["application", "postgres", "mysql", "mariadb", "mongo", "redis", "compose", "libsql"])
      .optional()
      .describe(
        "Which kind of service serviceId refers to. Dokploy declares this optional; pass it " +
          "whenever the service is not an application",
      ),
    filePath: z
      .string()
      .min(1)
      .optional()
      .describe("File path inside the container, for mounts that provide a single file"),
    // Part of every branch, because the confirmation gate must be part of the type: a mount
    // schema that let `confirm` fall out of the union would compile without a gate.
    confirm: ConfirmSchema,
  };

  const CreateMountInput = z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("bind"),
        hostPath: z
          .string()
          .min(1)
          .describe("Absolute path on the Docker host. It must already exist"),
        ...mountCommon,
      })
      .strict(),
    z
      .object({
        type: z.literal("volume"),
        volumeName: z
          .string()
          .min(1)
          .describe("Name of the Docker named volume. Created if it does not exist"),
        ...mountCommon,
      })
      .strict(),
    z
      .object({
        type: z.literal("file"),
        content: z
          .string()
          .min(1)
          .describe("Literal file contents Dokploy writes into the container"),
        ...mountCommon,
      })
      .strict(),
  ]);

  defineTool(
    server,
    context,
    "dokploy_create_mount",
    {
      title: "Create A Mount On A Service",
      description: `Attach a bind mount, a named volume or a file to a service.

Which arguments are required depends on \`type\`, and Dokploy rejects the other combinations:
- \`bind\` requires \`hostPath\` — a directory or file already present on the Docker host
- \`volume\` requires \`volumeName\` — a Docker named volume, created on first use
- \`file\` requires \`content\` — the literal text Dokploy writes for you

Dokploy re-applies the service after a mount is added, which restarts its containers.

Args:
  - type (enum, required): 'bind' | 'volume' | 'file'
  - hostPath (string, required for bind): Absolute path on the Docker host
  - volumeName (string, required for volume): Docker named volume
  - content (string, required for file): Literal file contents
  - mountPath (string, required): Absolute path inside the container
  - serviceId (string, required): The service to attach the mount to
  - serviceType (enum, optional): 'application' | 'postgres' | 'mysql' | 'mariadb' | 'mongo' |
    'redis' | 'compose' | 'libsql'. Dokploy declares this optional; pass it whenever the
    service is not an application
  - filePath (string, optional): File path inside the container for single-file mounts
  - confirm (boolean, required): Must be true. The service is re-applied, so its containers
    restart

Returns:
  Dokploy's own response body, verbatim, plus a \`mountId\` when Dokploy returns one. Its
  shape is not declared in the v0.30.8 spec; without a \`mountId\` the mount is found by
  re-listing.

Examples:
  - Use when: "the API needs to write uploads" ->
    { type: "bind", hostPath: "/srv/uploads", mountPath: "/app/uploads",
      serviceId: "<applicationId>", serviceType: "application", confirm: true }
  - Use when: a database needs durable storage ->
    { type: "volume", volumeName: "pgdata", mountPath: "/var/lib/postgresql/data", … }
  - Don't use when: the host path does not exist yet -> create it on the host first, Dokploy
    does not create host directories for you

Error Handling:
  - confirm !== true -> refuses without calling the API
  - 400 -> a zod error naming the offending field; the union above normally catches it first
  - A mount is not rolled back automatically if the service fails to come back up`,
      inputSchema: CreateMountInput,
      annotations: DISRUPTIVE,
    },
    async (input): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        input.confirm === true,
        "Adding a mount re-applies the service, which restarts its containers.",
        "Re-run with confirm: true once the host path or volume name is correct.",
      );
      if (refusal) return refusal;

      // Only the branch's own source field is forwarded. Sending the other two as null is
      // accepted by Dokploy's schema but leaves no way to tell which shape was intended.
      const payload: Record<string, unknown> = {
        type: input.type,
        mountPath: input.mountPath,
        serviceId: input.serviceId,
        serviceType: input.serviceType,
        filePath: input.filePath,
      };
      if (input.type === "bind") payload.hostPath = input.hostPath;
      else if (input.type === "volume") payload.volumeName = input.volumeName;
      else payload.content = input.content;

      const response = await context.client.mutation<unknown>("mounts.create", payload);
      // Dokploy declares the create body as a bare `object`, so the new id is read
      // defensively rather than assumed: without it the mount can only be found by listing.
      const body = response as Record<string, unknown> | null;
      const mountId =
        typeof body?.mountId === "string"
          ? body.mountId
          : typeof body?.id === "string"
            ? body.id
            : null;

      const structured = {
        created: true,
        mountId,
        type: input.type,
        mountPath: input.mountPath,
        serviceId: input.serviceId,
        serviceType: input.serviceType ?? null,
        response,
      };
      return renderResult({
        format: "markdown",
        title: `Mount created on ${input.serviceId}`,
        structured,
        markdown: () =>
          [
            `- **Type**: ${input.type}`,
            `- **Mount path**: \`${input.mountPath}\``,
            `- **Service**: \`${input.serviceId}\`${input.serviceType ? ` (${input.serviceType})` : ""}`,
            `- **mountId**: ${mountId === null ? "not returned — re-list with dokploy_list_mounts" : `\`${mountId}\``}`,
            "",
            "```",
            typeof response === "string" ? response : JSON.stringify(response, null, 2),
            "```",
          ].join("\n"),
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_delete_mount",
    {
      title: "Delete A Mount",
      description: `Remove a mount from a service by its mountId.

Deleting a \`volume\` mount does not delete the volume's contents, but the service stops
seeing them, and deleting a \`bind\` mount hides whatever was on that host path. Either way
the service is re-applied and its containers restart.

Args:
  - mountId (string, required): The mount id from dokploy_list_mounts
  - confirm (boolean, required): Must be true. Anything the service was reading through this
    mount becomes unreachable

Returns: Dokploy's own response body, verbatim.

Examples:
  - Use when: "the old upload path is gone, drop the mount" -> { mountId: "…", confirm: true }
  - Don't use when: you want the files gone too -> delete the host directory or volume
    yourself; this only detaches it

Error Handling:
  - confirm !== true -> refuses without calling the API
  - 404 -> no mount with that id`,
      inputSchema: z
        .object({
          mountId: IdSchema.describe("The mount id from dokploy_list_mounts"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async (input): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        input.confirm === true,
        "Removing a mount hides its data from the service and restarts its containers.",
        "Re-run with confirm: true after checking the mountId against dokploy_list_mounts.",
      );
      if (refusal) return refusal;

      const response = await context.client.mutation<unknown>("mounts.remove", {
        mountId: input.mountId,
      });
      const structured = { removed: true, mountId: input.mountId, response };
      return renderResult({
        format: "markdown",
        title: `Mount ${input.mountId} removed`,
        structured,
        markdown: () =>
          [
            `- **mountId**: \`${input.mountId}\``,
            "",
            "```",
            typeof response === "string" ? response : JSON.stringify(response, null, 2),
            "```",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------- registries & ssh keys */

  defineTool(
    server,
    context,
    "dokploy_list_registries",
    {
      title: "List Private Registries",
      description: `List the private container registries configured on this instance.

A registry that is present but unusable is a common cause of a build failing at the pull
step, so check this before re-running a build.

Args: none

Returns:
  { "items": [ { "registryId": "…", "name": "ghcr", "registryType": "private",
                 "url": "ghcr.io", "createdAt": "…" } ], "total": 2 }

Examples:
  - Use when: "is our private registry configured?" -> look for its name
  - Don't use when: a public image fails to pull -> no registry is involved

Error Handling:
  - Empty list is normal on an instance that only uses public images
  - Credential fields are deliberately not rendered here`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("registry.all");
      const items = toItems<Record<string, unknown>>(payload);
      const rows = items.map((registry) => ({
        name: text(registry, "name", "registryName", "registry_name"),
        id: text(registry, "registryId", "id", "registry_id"),
        type: text(registry, "registryType", "registry_type", "type"),
        url: text(registry, "url", "registryUrl", "registry_url"),
        username: text(registry, "username"),
        createdAt: humanTime(pick(registry, "createdAt", "created_at")),
      }));
      const structured = { items: rows, total: items.length };

      return renderResult({
        format: "markdown",
        title: `Registries (${rows.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "No private registries are configured.",
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [
            ...COMMON_COLUMNS.slice(0, 2),
            { key: "type", label: "Type" },
            { key: "url", label: "URL" },
            { key: "username", label: "Username" },
            { key: "createdAt", label: "Created" },
          ]),
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_list_ssh_keys",
    {
      title: "List SSH Deploy Keys",
      description: `List the SSH keys services can use to clone a private repository.

A compose stack whose source is a private Git repository cannot deploy until one of these
names appears in its configuration. Private key material is deliberately never returned
here — only the key's name, id and creation time.

Args: none

Returns: { "items": [ { "sshKeyId": "…", "name": "deploy-key", "createdAt": "…" } ], "total": 1 }

Examples:
  - Use when: a clone fails with "permission denied (publickey)" -> is a key configured?
  - Don't use when: the repository is public -> no SSH key is needed

Error Handling:
  - Empty list is normal on an instance that only clones public repositories`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("sshKey.all");
      const items = toItems<Record<string, unknown>>(payload);
      const rows = items.map((key_) => ({
        name: text(key_, "name", "sshKeyName", "ssh_key_name"),
        id: text(key_, "sshKeyId", "id", "ssh_key_id"),
        detail: text(key_, "description"),
        createdAt: humanTime(pick(key_, "createdAt", "created_at")),
      }));
      const structured = { items: rows, total: items.length };

      return renderResult({
        format: "markdown",
        title: `SSH keys (${rows.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "No SSH keys are configured. Private Git clones will fail.",
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [...COMMON_COLUMNS]),
      });
    },
  );

  /* --------------------------------------------- networks & cluster nodes */

  defineTool(
    server,
    context,
    "dokploy_list_networks",
    {
      title: "List Docker Networks",
      description: `List the Docker networks available for services to join.

Containers on different networks cannot resolve each other by service name, so when a
service cannot reach its database this list is the first thing to check.

Args:
  - serverId (string, optional): Restrict to one registered server

Returns:
  { "items": [ { "networkId": "…", "name": "ai-router-network", "driver": "overlay",
                 "scope": "swarm" } ], "total": 3 }

Examples:
  - Use when: "can the app reach the database?" -> confirm both share a network
  - Don't use when: you want the networks a specific service is attached to -> this lists
    every network on the host, not a service's membership

Error Handling:
  - 404 -> wrong serverId
  - An empty list is normal on a fresh install`,
      inputSchema: z
        .object({
          serverId: z.string().optional().describe("Restrict to one registered server"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("network.all", { serverId: input.serverId });
      const items = toItems<Record<string, unknown>>(payload);
      const rows = items.map((network) => ({
        name: text(network, "name", "Name"),
        id: text(network, "networkId", "id", "Id"),
        driver: text(network, "driver", "Driver"),
        scope: text(network, "scope", "Scope"),
        createdAt: humanTime(pick(network, "createdAt", "created_at")),
      }));
      const structured = { items: rows, total: items.length, serverId: input.serverId ?? null };

      return renderResult({
        format: "markdown",
        title: `Networks (${rows.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "No Docker networks were returned for this host.",
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [
            { key: "name", label: "Name" },
            { key: "id", label: "Id" },
            { key: "driver", label: "Driver" },
            { key: "scope", label: "Scope" },
          ]),
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_list_cluster_nodes",
    {
      title: "List Cluster Nodes",
      description: `List the nodes in this instance's Docker Swarm cluster.

On a single-host install this returns one node, which is normal. It matters when a deploy
fails only sometimes: a second node that is \`Down\` or \`Drain\` accepts scheduling decisions
it then cannot honour.

Args:
  - serverId (string, optional): Restrict to one registered server

Returns:
  { "items": [ { "nodeId": "…", "hostname": "dokploy-1", "status": "active",
                 "availability": "active" } ], "total": 1 }

Examples:
  - Use when: a service is scheduled but never starts -> is every node ready?
  - Don't use when: the instance runs a single host -> one active node is the whole answer

Error Handling:
  - 404 -> wrong serverId
  - An empty list usually means this instance is not a Swarm manager`,
      inputSchema: z
        .object({
          serverId: z.string().optional().describe("Restrict to one registered server"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("cluster.getNodes", {
        serverId: input.serverId,
      });
      const items = toItems<Record<string, unknown>>(payload);
      const rows = items.map((node) => ({
        name: text(node, "hostname", "name", "Name"),
        id: text(node, "nodeId", "id", "Id"),
        detail: text(node, "status"),
        availability: text(node, "availability", "Availability"),
        createdAt: humanTime(pick(node, "createdAt", "created_at")),
      }));
      const structured = { items: rows, total: items.length, serverId: input.serverId ?? null };

      return renderResult({
        format: "markdown",
        title: `Cluster nodes (${rows.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty:
          "No cluster nodes were returned. This instance is probably not a Swarm manager, which is normal for a single-host install.",
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [
            { key: "name", label: "Hostname" },
            { key: "id", label: "Node id" },
            { key: "detail", label: "Status" },
            { key: "availability", label: "Availability" },
          ]),
      });
    },
  );

  /* ----------------------------------------------------------- audit logs */

  /** Both enums are copied from the pinned spec, not guessed. */
  const AUDIT_ACTIONS = [
    "create",
    "update",
    "delete",
    "deploy",
    "cancel",
    "redeploy",
    "login",
    "logout",
  ] as const;

  const AUDIT_RESOURCE_TYPES = [
    "project",
    "service",
    "environment",
    "deployment",
    "user",
    "customRole",
    "domain",
    "certificate",
    "registry",
    "server",
    "sshKey",
    "gitProvider",
    "notification",
    "settings",
    "session",
  ] as const;

  defineTool(
    server,
    context,
    "dokploy_list_audit_logs",
    {
      title: "Search Audit Logs",
      description: `Read who changed what, in order to answer "did anyone deploy this?".

Every mutation Dokploy records lands here, so this is the audit trail for a change nobody
admits to. All filters are optional and combine.

Args:
  - userId (string, optional): Only entries by this user id
  - userEmail (string, optional): Only entries by this email
  - resourceName (string, optional): Only entries about this resource name
  - action (enum, optional): 'create' | 'update' | 'delete' | 'deploy' | 'cancel' | 'redeploy' |
    'login' | 'logout'
  - resourceType (enum, optional): 'project' | 'service' | 'environment' | 'deployment' | 'user' |
    'customRole' | 'domain' | 'certificate' | 'registry' | 'server' | 'sshKey' | 'gitProvider' |
    'notification' | 'settings' | 'session'
  - from (string, optional): ISO 8601 lower bound, e.g. "2026-01-01T00:00:00.000Z"
  - to (string, optional): ISO 8601 upper bound
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "items": [ { "createdAt": "2026-01-01 10:00:00Z", "action": "deploy",
                 "resourceType": "service", "resourceName": "api", "userEmail": "a@b.vn" } ],
    "total": 143, "count": 20, "offset": 0, "has_more": true, "next_offset": 20 }

Examples:
  - Use when: "who deployed at 3am?" -> { action: "deploy", from: "…" }
  - Use when: "was this service deleted and recreated?" -> { resourceType: "service",
    resourceName: "api" }
  - Don't use when: you want the log output of a running service -> use
    dokploy_get_service_health

Error Handling:
  - 400 -> an unparseable \`from\`/\`to\`; pass full ISO 8601 timestamps
  - No match -> an empty items array with has_more false`,
      inputSchema: z
        .object({
          userId: z.string().optional().describe("Only entries by this user id"),
          userEmail: z.string().optional().describe("Only entries by this email"),
          resourceName: z.string().optional().describe("Only entries about this resource name"),
          action: z.enum(AUDIT_ACTIONS).optional().describe("Only this action"),
          resourceType: z.enum(AUDIT_RESOURCE_TYPES).optional().describe("Only this resource type"),
          from: z.string().optional().describe("ISO 8601 lower bound, e.g. 2026-01-01T00:00:00.000Z"),
          to: z.string().optional().describe("ISO 8601 upper bound"),
          ...PaginationSchema,
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("auditLog.all", {
        userId: input.userId,
        userEmail: input.userEmail,
        resourceName: input.resourceName,
        action: input.action,
        resourceType: input.resourceType,
        from: input.from,
        to: input.to,
        limit: input.limit,
        offset: input.offset,
      });
      const page = paginate<Record<string, unknown>>(
        payload as { items: Record<string, unknown>[]; total: number } | Record<string, unknown>[],
        input.limit,
        input.offset,
      );
      const rows = page.items.map((entry) => ({
        createdAt: humanTime(pick(entry, "createdAt", "created_at")),
        action: text(entry, "action", "Action"),
        resourceType: text(entry, "resourceType", "resource_type"),
        resourceName: text(entry, "resourceName", "resource_name"),
        userEmail: text(entry, "userEmail", "user_email"),
        userId: text(entry, "userId", "user_id"),
      }));

      return renderResult({
        format: input.response_format,
        title: `Audit log (${page.count}/${page.total})`,
        structured: { ...page, items: rows },
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "No audit entries matched those filters.",
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [
            { key: "createdAt", label: "When" },
            { key: "action", label: "Action" },
            { key: "resourceType", label: "Resource type" },
            { key: "resourceName", label: "Resource" },
            { key: "userEmail", label: "User" },
          ]),
      });
    },
  );

  /* ------------------------------------------------ notification channels */

  defineTool(
    server,
    context,
    "dokploy_list_notification_channels",
    {
      title: "List Notification Channels",
      description: `List the notification channels Dokploy posts deploy and failure alerts to.

If "we were never told it failed" is the question, this is where the answer is: an empty list
means those alerts are going nowhere.

Args: none

Returns:
  { "items": [ { "name": "ops-slack", "type": "slack", "createdAt": "…" } ], "total": 1 }

Examples:
  - Use when: "why did nobody get the failure alert?" -> is a channel configured?
  - Don't use when: you want to add one -> this server exposes reads only for notifications,
    because a chat integration is not something an agent should create unasked

Error Handling:
  - Empty list is normal on an instance with no alerting set up`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("notification.all");
      const items = toItems<Record<string, unknown>>(payload);
      const rows = items.map((channel) => ({
        name: text(channel, "name", "Name"),
        id: text(channel, "notificationId", "id"),
        detail: text(channel, "notificationType", "type", "channel"),
        createdAt: humanTime(pick(channel, "createdAt", "created_at")),
      }));
      const structured = { items: rows, total: items.length };

      return renderResult({
        format: "markdown",
        title: `Notification channels (${rows.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "No notification channels are configured. Deploy and failure alerts go nowhere.",
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [...COMMON_COLUMNS]),
      });
    },
  );

  /* ---------------------------------------------------------- git branches */

  /**
   * The four providers disagree on argument names — Gitea says `repositoryName` where the
   * others say `repo`, and GitLab alone accepts a numeric project `id`. Modelled as a
   * discriminated union so the schema states each provider's real contract instead of
   * accepting a `repo` that the server would reject.
   */
  const GitBranchesInput = z.discriminatedUnion("provider", [
    z
      .object({
        provider: z.literal("github"),
        owner: z.string().min(1).describe("GitHub user or organisation"),
        repo: z.string().min(1).describe("Repository name"),
        githubId: z
          .string()
          .optional()
          .describe("The GitHub account configured in Dokploy. Omit when there is only one"),
      })
      .strict(),
    z
      .object({
        provider: z.literal("gitlab"),
        owner: z.string().min(1).describe("GitLab namespace, group or user"),
        repo: z.string().min(1).describe("Project name"),
        gitlabId: z
          .string()
          .optional()
          .describe("The GitLab account configured in Dokploy. Omit when there is only one"),
        id: z
          .number()
          .int()
          .optional()
          .describe("GitLab numeric project id, accepted instead of owner/repo by Dokploy"),
      })
      .strict(),
    z
      .object({
        provider: z.literal("gitea"),
        owner: z.string().min(1).describe("Gitea user or organisation"),
        repositoryName: z
          .string()
          .min(1)
          .describe("Repository name. Gitea calls this `repositoryName`, not `repo`"),
        giteaId: z
          .string()
          .optional()
          .describe("The Gitea account configured in Dokploy. Omit when there is only one"),
      })
      .strict(),
    z
      .object({
        provider: z.literal("bitbucket"),
        owner: z.string().min(1).describe("Bitbucket workspace or user"),
        repo: z.string().min(1).describe("Repository name"),
        bitbucketId: z
          .string()
          .optional()
          .describe("The Bitbucket account configured in Dokploy. Omit when there is only one"),
      })
      .strict(),
  ]);

  defineTool(
    server,
    context,
    "dokploy_list_git_branches",
    {
      title: "List Branches Of A Git Repository",
      description: `List the branches of a repository Dokploy can deploy from.

Use it to confirm a branch exists before wiring it into a service: Dokploy accepts a branch
name and fails later, at clone time, when it does not exist. Each provider takes its own
argument names, so the schema branches on \`provider\`.

Args:
  - provider (enum, required): 'github' | 'gitlab' | 'gitea' | 'bitbucket'
  - owner (string, required): The user, organisation or namespace that owns the repository
  - repo (string, required for github/gitlab/bitbucket): Repository name
  - repositoryName (string, required for gitea): Repository name — Gitea's own parameter name
  - githubId | gitlabId | giteaId | bitbucketId (string, optional): The account configured in
    Dokploy. Omit when the instance has only one
  - id (number, optional): GitLab only. Dokploy also accepts the numeric project id instead
    of owner/repo

Returns:
  { "items": [ { "name": "main" }, { "name": "develop" } ], "count": 2,
    "provider": "github" }

Examples:
  - Use when: "does the develop branch exist?" ->
    { provider: "github", owner: "acme", repo: "api" }
  - Use when: a Gitea-hosted compose refuses to deploy -> { provider: "gitea", owner: "acme",
    repositoryName: "stack" }
  - Don't use when: you have already chosen the branch and only need the service deployed ->
    use dokploy_deploy_service

Error Handling:
  - 404 -> the repository, the provider account, or the branch list is unreachable; check that
    the git provider is configured in Dokploy
  - An empty list is a valid answer: the repository has no branches yet`,
      inputSchema: GitBranchesInput,
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const target = PROVIDERS[input.provider];

      const params: Record<string, unknown> = { owner: input.owner };
      if (input.provider === "gitea") {
        params.repositoryName = input.repositoryName;
      } else {
        params.repo = input.repo;
      }
      const account = (input as Record<string, unknown>)[target.accountKey];
      if (account !== undefined) params[target.accountKey] = account;
      if (input.provider === "gitlab" && input.id !== undefined) params.id = input.id;

      const payload = await context.client.query<unknown>(target.procedure, params);
      const raw = toItems<unknown>(payload);
      const items = raw.map((branch) => {
        if (typeof branch === "string") return { name: branch };
        const record = branch as Record<string, unknown>;
        return {
          name: text(record, "name", "branch"),
          commit: text(record, "commit", "commitSha", "sha", "commit_hash"),
        };
      });
      const structured = {
        provider: input.provider,
        repository: input.provider === "gitea" ? input.repositoryName : input.repo,
        owner: input.owner,
        items,
        count: items.length,
      };

      return renderResult({
        format: "markdown",
        title: `Branches of ${input.owner}/${structured.repository} (${items.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `${input.provider} reported no branches for ${input.owner}/${structured.repository}.`,
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [
            { key: "name", label: "Branch" },
            { key: "commit", label: "Commit" },
          ]),
      });
    },
  );
}