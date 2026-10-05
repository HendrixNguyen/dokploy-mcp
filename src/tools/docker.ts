/**
 * Docker container tools.
 *
 * These reach past Dokploy's own model and talk to the Docker daemon underneath it. That
 * makes them the blunt instruments of this server: a container id here is a raw Docker
 * object, not a Dokploy service, and restarting one restarts it without redeploying,
 * re-resolving its configuration or recording a deployment.
 *
 * Reach for them when a service is wedged in a way a Dokploy-level operation cannot fix —
 * a container that will not stop, or a host whose stats are needed to explain why a build
 * is slow. For ordinary lifecycle work prefer the application/compose/database tools,
 * which understand service ids and keep Dokploy's state in step.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clampLimit, clampOffset, renderResult, table, type PageEnvelope } from "../format.js";
import type { ContainerSummary } from "../types.js";
import { ConfirmSchema, IdSchema, PaginationSchema, ResponseFormatSchema } from "../schemas/common.js";
import {
  defineTool,
  DISRUPTIVE,
  READ_ONLY,
  requireConfirmation,
  type ToolContext,
  type ToolResult,
} from "./registry.js";

/**
 * Dokploy declares every 200 body as a bare `object`, so list responses arrive either as
 * an array or wrapped in `{ items }` depending on the procedure. Normalising here keeps the
 * handlers from re-deriving it.
 */
function toItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}

/** First defined value among `keys`, matched case-insensitively. */
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

/** `/api-router` -> `api-router`; Docker prefixes every compose stack container. */
function containerName(container: ContainerSummary): string {
  // Dokploy re-keys Docker's fields into snake_case (`name`, `containerId`); the Docker
  // spellings are kept as fallbacks so a version that returns the native shape still works.
  const names = container.Names;
  if (Array.isArray(names) && names.length > 0) {
    return String(names[0]).replace(/^\//, "");
  }
  const named = pick(container as Record<string, unknown>, "name", "Name");
  if (typeof named === "string" && named.length > 0) return named;
  return container.containerId ?? container.IdShort ?? "—";
}

export function registerDocker(server: McpServer, context: ToolContext): void {
  /* ------------------------------------------------------- list containers */

  defineTool(
    server,
    context,
    "dokploy_list_containers",
    {
      title: "List Docker Containers On The Host",
      description: `List the Docker containers running on this instance or on a registered server.

This is the raw Docker view: containers that Dokploy has no record of are visible here,
and a Dokploy service appears as one or more containers. Use it when you hold a container id
for one of the container tools below, or to find out what is actually running.

Args:
  - serverId (string, optional): Restrict to one registered server. Omit for this instance's own host
  - state (string, optional): Only containers in this Docker state, e.g. "running", "exited",
    "paused". Matched case-insensitively against the container's \`state\` field
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "items": [ { "containerId": "7516388c2a36", "name": "api-xyz", "image": "ghcr.io/org/api:latest",
                 "state": "running", "status": "Up 3 days", "ports": "0.0.0.0:8080->80/tcp" } ],
    "total": 12, "count": 12, "offset": 0, "has_more": false }

Examples:
  - Use when: "is the API container running?" -> { state: "running" }
  - Use when: you need a container id for dokploy_restart_container
  - Don't use when: you want to deploy or inspect a service by name -> use
    dokploy_describe_service, which understands Dokploy ids rather than Docker ones

Error Handling:
  - 404 -> wrong serverId
  - An empty list is normal on a host with nothing running`,
      inputSchema: z
        .object({
          serverId: z.string().optional().describe("Restrict to one registered server"),
          state: z
            .string()
            .optional()
            .describe('Only containers in this Docker state, e.g. "running", "exited", "paused"'),
          ...PaginationSchema,
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const payload = await context.client.query<ContainerSummary[]>("docker.getContainers", {
        serverId: input.serverId,
      });
      const all = toItems<ContainerSummary>(payload);
      const filtered =
        input.state === undefined
          ? all
          : all.filter(
              (container) =>
                String(pick(container as Record<string, unknown>, "State", "state") ?? "")
                  .toLowerCase() === input.state?.toLowerCase(),
            );
      const limit = clampLimit(input.limit);
      const offset = clampOffset(input.offset);
      const items = filtered.slice(offset, offset + limit);
      // Paged here rather than by Dokploy: `docker.getContainers` takes no limit or offset.
      const page: PageEnvelope<ContainerSummary> = {
        total: filtered.length,
        count: items.length,
        offset,
        items,
        has_more: offset + items.length < filtered.length,
      };
      if (page.has_more) page.next_offset = offset + items.length;

      return renderResult({
        format: input.response_format,
        title: `Containers (${page.count}/${filtered.length})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: input.state
          ? `No container is in state "${input.state}" on this host.`
          : "No containers are running on this host.",
        markdown: (data) => {
          const rows = (data as { items: ContainerSummary[] }).items.map((container) => ({
            name: containerName(container),
            id: container.containerId ?? container.IdShort ?? "—",
            image: container.image ?? String(pick(container as Record<string, unknown>, "Image") ?? "—"),
            state:
              container.state ?? String(pick(container as Record<string, unknown>, "State") ?? "—"),
            status:
              container.status ?? String(pick(container as Record<string, unknown>, "Status") ?? "—"),
            ports: container.ports && container.ports.length > 0 ? container.ports : "—",
          }));
          return table(rows, [
            { key: "name", label: "Name" },
            { key: "id", label: "Container id" },
            { key: "image", label: "Image" },
            { key: "state", label: "State" },
            { key: "status", label: "Status" },
            { key: "ports", label: "Ports" },
          ]);
        },
      });
    },
  );

  /* ----------------------------------------------- start / stop / restart */

  /**
   * The three lifecycle tools differ only in the procedure they call and in what they warn
   * about, so they are generated from one description rather than copy-pasted three times:
   * a divergent copy is how a start tool ends up described as a delete.
   */
  const lifecycle = [
    {
      tool: "dokploy_start_container",
      procedure: "docker.startContainer",
      verb: "Start",
      title: "Start A Docker Container",
      blurb: "Start a container that is stopped, created or paused.",
      consequence: "Starting a container puts a process back into serving traffic.",
      working: "Pass the containerId from dokploy_list_containers, with confirm: true.",
    },
    {
      tool: "dokploy_stop_container",
      procedure: "docker.stopContainer",
      verb: "Stop",
      title: "Stop A Docker Container",
      blurb: "Stop a running container.",
      consequence:
        "Stopping a container cuts its traffic immediately. If it belongs to a Dokploy service, " +
        "the service reports as unhealthy until something restarts it, and Dokploy records no " +
        "deployment for the change.",
      working:
        "Pass the containerId from dokploy_list_containers with confirm: true once you have " +
        "checked the service is meant to be down.",
    },
    {
      tool: "dokploy_restart_container",
      procedure: "docker.restartContainer",
      verb: "Restart",
      title: "Restart A Docker Container",
      blurb: "Restart a container, leaving its configuration and volumes untouched.",
      consequence:
        "Restarting drops in-flight requests and, for a service container, leaves Dokploy's own " +
        "status out of step until the health check catches up.",
      working:
        "Pass the containerId from dokploy_list_containers with confirm: true. To redeploy from " +
        "source instead, use dokploy_deploy_service.",
    },
  ] as const;

  for (const entry of lifecycle) {
    defineTool(
      server,
      context,
      entry.tool,
      {
        title: entry.title,
        description: `${entry.blurb}

This acts on the Docker daemon directly: it does not redeploy, does not re-read the service's
configuration, and does not create a deployment record. Reach for it when a container is
wedged and a redeploy would be too slow, or when you need one container of a multi-container
stack restarted.

Args:
  - containerId (string, required): The Docker container id, as reported by
    dokploy_list_containers (either the full \`Id\` or the short \`IdShort\`)
  - serverId (string, optional): The server hosting the container. Omit for this instance's own host
  - confirm (boolean, required): Must be true. ${entry.consequence}

Returns:
  Dokploy's own response body, verbatim. Its shape is not declared in the v0.30.8 spec —
  expect a short acknowledgement such as { "message": "Container restarted" }.

Examples:
  - Use when: "the API container is wedged, restart it" ->
    { containerId: "a1b2c3", confirm: true }
  - Use when: a container is stuck in \`Created\` after a failed deploy -> start_container
  - Don't use when: you want the configured service redeployed from source -> use
    dokploy_deploy_service, which keeps Dokploy's own state consistent

Error Handling:
  - confirm !== true -> refuses without calling the API
  - 404 -> no such container on that server
  - The procedure answers on the Docker daemon, so a container Dokploy does not manage is
    reachable here too`,
        inputSchema: z
          .object({
            containerId: IdSchema.describe("The Docker container id"),
            serverId: z.string().optional().describe("The server hosting the container"),
            confirm: ConfirmSchema,
          })
          .strict(),
        annotations: DISRUPTIVE,
      },
      async (input): Promise<ToolResult> => {
        const refusal = requireConfirmation(
          input.confirm === true,
          `${entry.verb}ing a container changes a running process outside Dokploy's knowledge.`,
          entry.working,
        );
        if (refusal) return refusal;

        const response = await context.client.mutation<unknown>(entry.procedure, {
          containerId: input.containerId,
          serverId: input.serverId,
        });

        const structured = {
          action: entry.verb.toLowerCase(),
          containerId: input.containerId,
          serverId: input.serverId ?? null,
          response,
        };
        return renderResult({
          format: "markdown",
          title: `${entry.verb}ed container ${input.containerId}`,
          structured,
          markdown: (data) => {
            const payload = (data as { response: unknown }).response;
            return [
              `- **Action**: ${entry.verb.toLowerCase()}`,
              `- **Container**: \`${input.containerId}\``,
              `- **Server**: ${input.serverId ?? "this instance"}`,
              "",
              "```",
              typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
              "```",
            ].join("\n");
          },
        });
      },
    );
  }

  /* ---------------------------------------------------------- stats */

  defineTool(
    server,
    context,
    "dokploy_list_container_stats",
    {
      title: "Read Docker Container Resource Usage",
      description: `Read live CPU, memory, network and block-io counters for running containers.

Use it when a service is slow or being evicted and you need to tell a resource ceiling from
an application problem. Dokploy declares this response as a bare \`object\`, so the field
names below are best-effort: whatever does not match is rendered as \`—\` rather than invented.

Args:
  - serverId (string, optional): Restrict to one registered server. Omit for this instance's own host
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "items": [ { "name": "api-xyz", "id": "a1b2c3", "cpu": "1.42%",
                 "memory": "120MiB / 512MiB (23.4%)", "network": "1.2MB / 340kB" } ],
    "count": 6 }

Examples:
  - Use when: "is the build being throttled?" -> read the cpu column
  - Use when: a container is being OOM-killed -> read memory, then restart it
  - Don't use when: you want a service's Dokploy status or deployment history -> use
    dokploy_get_service_health, which answers that in one call

Error Handling:
  - 404 -> wrong serverId
  - An empty list is normal when nothing is running`,
      inputSchema: z
        .object({
          serverId: z.string().optional().describe("Restrict to one registered server"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("swarm.getContainerStats", {
        serverId: input.serverId,
      });
      const items = toItems<Record<string, unknown>>(payload);
      const rows = items.map((stats) => ({
        name: String(pick(stats, "name", "Name") ?? "—"),
        id: String(pick(stats, "id", "Id", "container_id", "containerId") ?? "—"),
        cpu: pick(stats, "cpu", "CPU", "cpuPercent", "cpu_percent") ?? "—",
        memory:
          pick(stats, "memory", "mem_usage", "memUsage", "mem_percent", "memPercent", "memoryPercent") ??
          "—",
        network: pick(stats, "network", "net_io", "netIo", "networkIO") ?? "—",
      }));
      const structured = { items: rows, count: rows.length, serverId: input.serverId ?? null };

      return renderResult({
        format: input.response_format,
        title: `Container stats (${rows.length})`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "No container statistics were returned. Nothing may be running, or the server is not a Swarm manager.",
        markdown: (data) =>
          table((data as { items: Record<string, unknown>[] }).items, [
            { key: "name", label: "Container" },
            { key: "id", label: "Id" },
            { key: "cpu", label: "CPU" },
            { key: "memory", label: "Memory" },
            { key: "network", label: "Network" },
          ]),
      });
    },
  );
}