/**
 * Deployment inspection and control.
 *
 * A deployment is one run of "build and ship this service". Dokploy keeps them as rows with
 * a status, a log file on disk and a pid, which makes this group half observability
 * (list, read logs, inspect the queue) and half control (kill a stuck run, roll back to an
 * earlier image).
 *
 * Listing is split across three procedures that take different keys and return different
 * shapes, so `dokploy_list_deployments` dispatches rather than exposing the split. Two facts
 * from the pinned spec shape the rest of this file:
 *
 *   - None of the three accepts `limit` or `offset`. Pagination here is client-side, and the
 *     tool says so, because an agent paging with `next_offset` would otherwise believe the
 *     server did the slicing.
 *   - `deployment.readLogs` accepts `deploymentId` and `tail` only. There is no `search`
 *     parameter, so the shared log schema's `search` is dropped rather than sent as an
 *     argument the endpoint rejects.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  clampLimit,
  clampOffset,
  humanTime,
  paginate,
  renderResult,
  table,
} from "../format.js";
import type { Deployment } from "../types.js";
import { LOG_TIMEOUT_MS } from "../constants.js";
import {
  ConfirmSchema,
  IdSchema,
  LogTailSchema,
  PaginationSchema,
  ResponseFormatSchema,
} from "../schemas/common.js";
import {
  defineTool,
  DESTRUCTIVE,
  READ_ONLY,
  requireConfirmation,
  type ToolContext,
  type ToolResult,
} from "./registry.js";

/** Which list procedure a (serviceType, serviceId) pair routes to. */
type DeploymentScope = "application" | "compose" | "centralized";

function deploymentRows(items: Deployment[]): Record<string, unknown>[] {
  return items.map((deployment) => ({
    status: deployment.status ?? "unknown",
    title: deployment.title ?? "",
    target:
      deployment.applicationId ?? deployment.composeId ?? deployment.previewDeploymentId ?? "—",
    deploymentId: deployment.deploymentId,
    createdAt: humanTime(deployment.createdAt),
    finishedAt: deployment.finishedAt ? humanTime(deployment.finishedAt) : "—",
  }));
}

const DEPLOYMENT_COLUMNS = [
  { key: "status", label: "Status" },
  { key: "title", label: "Title" },
  { key: "target", label: "Target" },
  { key: "deploymentId", label: "deploymentId" },
  { key: "createdAt", label: "Started" },
  { key: "finishedAt", label: "Finished" },
] as const;

/** Dokploy returns either a bare array or `{ items, total }` depending on the procedure. */
function itemsOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  const items = (payload as { items?: unknown[] } | null)?.items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

/** Local input error, shaped like every other refusal in this server. */
function inputError(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function registerDeployments(server: McpServer, context: ToolContext): void {
  /* ------------------------------------------------------ list deployments */

  defineTool(
    server,
    context,
    "dokploy_list_deployments",
    {
      title: "List Deployments, Scoped To One Service Or The Whole Instance",
      description: `List deployments, newest first.

Dokploy has three separate list endpoints and none of them agrees on its key, so this tool
picks one for you:

  - \`serviceType: 'application'\` + \`serviceId\` -> \`deployment.all\` (\`applicationId\`)
  - \`serviceType: 'compose'\`      + \`serviceId\` -> \`deployment.allByCompose\` (\`composeId\`)
  - neither                         -> \`deployment.allCentralized\` (every service)

Only one id is ever sent. Passing \`serviceId\` without \`serviceType\` is refused rather than
guessed, because a wrong guess silently returns another service's deployments.

None of the three endpoints accepts \`limit\` or \`offset\`, so paging is done here: \`limit\`
and \`offset\` slice an already-fetched list. \`total\` is the count the slice was taken from,
which is the whole set for that scope.

Args:
  - serviceType ('application' | 'compose', optional): Which service kind \`serviceId\` refers
    to. Omit for both to list every deployment on the instance.
  - serviceId (string, optional): The applicationId or composeId, per \`serviceType\`.
    Required whenever \`serviceType\` is given.
  - limit (number, optional): 1-100, default 20
  - offset (number, optional): Rows to skip, default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns:
  { "scope": "application", "total": 12, "count": 5, "offset": 0,
    "items": [ { "deploymentId": "…", "status": "success", "title": "Deploy api",
                 "createdAt": "2026-10-01T…", "finishedAt": "2026-10-01T…" } ],
    "has_more": true }

Examples:
  - Use when: "did my last deploy succeed?" -> { serviceType: "application", serviceId: "…" }
  - Use when: "what has been deployed on this instance today?" -> no arguments at all
  - Use when: "why did the build fail?" -> list first, then pass the failing deploymentId to
    dokploy_get_deployment_logs
  - Don't use when: you want a running service's own container logs -> deployment logs cover
    the build, not the runtime

Error Handling:
  - Missing serviceType with a serviceId -> refused locally with the two options; nothing is sent
  - 404 -> the service id does not exist; resolve it with dokploy_resolve_service
  - An empty list means no deployment has ever run for that scope, not a failed call`,
      inputSchema: z
        .object({
          serviceType: z
            .enum(["application", "compose"])
            .optional()
            .describe("Which kind of service serviceId refers to. Omit for the whole instance"),
          serviceId: z
            .string()
            .min(1)
            .optional()
            .describe("The applicationId or composeId. Required whenever serviceType is given"),
          ...PaginationSchema,
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async (input): Promise<ToolResult> => {
      const hasType = input.serviceType !== undefined;
      const hasId = input.serviceId !== undefined;

      if (hasType !== hasId) {
        return inputError(
          hasType
            ? `"serviceType": "${input.serviceType}" was given without "serviceId". Dokploy's two ` +
                "scoped endpoints both require the id, and this tool will not guess which service " +
                "you meant. Pass serviceId, or drop serviceType to list the whole instance."
            : `"serviceId" was given without "serviceType". The same id shape could be an ` +
                "application or a compose stack, and picking wrong returns another service's " +
                "deployments. Add serviceType: 'application' or 'compose'.",
        );
      }

      let scope: DeploymentScope;
      let procedure: string;
      let params: Record<string, unknown>;
      if (input.serviceType === "application" && input.serviceId) {
        scope = "application";
        procedure = "deployment.all";
        params = { applicationId: input.serviceId };
      } else if (input.serviceType === "compose" && input.serviceId) {
        scope = "compose";
        procedure = "deployment.allByCompose";
        params = { composeId: input.serviceId };
      } else {
        scope = "centralized";
        procedure = "deployment.allCentralized";
        params = {};
      }

      const payload = await context.client.query<unknown>(procedure, params);
      const all = itemsOf(payload);
      const limit = clampLimit(input.limit);
      const offset = clampOffset(input.offset);
      const window = all.slice(offset, offset + limit);
      // `paginate` would report `total` as the length of the window it was handed. Here
      // `total` has to mean the whole scope, or `has_more` would lie about the fetch.
      const envelope = paginate(window, limit, offset);
      const structured: Record<string, unknown> = {
        scope,
        procedure,
        total: all.length,
        count: envelope.count,
        offset,
        items: window,
        has_more: envelope.has_more,
      };
      if (envelope.next_offset !== undefined) structured.next_offset = envelope.next_offset;

      return renderResult({
        format: input.response_format,
        title: `Deployments (${scope}) ${offset}-${offset + window.length} of ${all.length}`,
        structured,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty:
          scope === "centralized"
            ? "No deployments have run on this instance yet."
            : `No deployments for ${scope} ${input.serviceId}.`,
        markdown: (data) =>
          table(deploymentRows((data as { items: Deployment[] }).items), DEPLOYMENT_COLUMNS),
      });
    },
  );

  /* ------------------------------------------------------- deployment logs */

  defineTool(
    server,
    context,
    "dokploy_get_deployment_logs",
    {
      title: "Read A Deployment's Build Log",
      description: `Read the tail of one deployment's log — the build and deploy transcript, which
is where a failed build explains itself.

The endpoint takes only \`deploymentId\` and \`tail\`; it has no substring filter, so narrowing
by content is not possible here. Raise \`tail\` instead, or read the log of a specific
deployment rather than the newest one.

Deployment logs are not runtime logs. If the deploy succeeded but the service is broken, the
answer is in the service's own container logs, not here.

Args:
  - deploymentId (string, required): From dokploy_list_deployments
  - tail (number, optional): Most recent lines to return, 1-10000, default 200
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: the log text, e.g. "Cloning into 'app'…\\nerror: failed to solve: …"

Examples:
  - Use when: "why did the build fail?" -> { deploymentId: "…", tail: 500 }
  - Use when: a deploy is stuck -> { deploymentId: "…", tail: 50 } for a quick look
  - Don't use when: you want the running container's output -> this is the build transcript

Error Handling:
  - 404 -> no deployment with that id; list deployments to find it
  - The log file may not exist yet for a deployment that has only just started — retry in a
    few seconds rather than raising \`tail\`
  - Very large logs are truncated by this server's response limit; narrow with \`tail\``,
      inputSchema: z
        .object({
          deploymentId: IdSchema.describe("The deployment whose log to read"),
          // `search` from LogTailSchema is deliberately omitted: `deployment.readLogs` has no
          // such parameter, and sending it would be rejected by the endpoint's zod schema.
          tail: LogTailSchema.tail,
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ deploymentId, tail, response_format }): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>(
        "deployment.readLogs",
        { deploymentId, tail },
        { timeoutMs: LOG_TIMEOUT_MS },
      );
      const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
      const structured = { deploymentId, tail, log: text };
      return renderResult({
        format: response_format,
        title: `Deployment log ${deploymentId} (last ${tail} lines)`,
        structured,
        markdown: () => "```\n" + text + "\n```",
      });
    },
  );

  /* ---------------------------------------------------------- queueList */

  defineTool(
    server,
    context,
    "dokploy_get_deployment_queue",
    {
      title: "Show The Deployment Queue",
      description: `List the deployments Dokploy currently has running or waiting.

A long queue with several \`pending\` rows is the normal reason a deploy "has not started
yet". Use this before killing anything: it distinguishes a stuck run from one that is simply
waiting behind others.

Args: none

Returns: the queued rows, e.g.
  [ { "deploymentId": "…", "status": "pending", "title": "Deploy api",
      "createdAt": "2026-10-01T…" } ]

Examples:
  - Use when: "why has my deploy not started?" -> read the queue
  - Use when: before killing a run, to check it is not simply queued
  - Don't use when: you want deployment history -> use dokploy_list_deployments

Error Handling:
  - None expected; an empty queue is the normal idle state
  - Entries are transient: a queued deployment disappears from this list as soon as it starts`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("deployment.queueList");
      const items = itemsOf(payload);
      const page = paginate(items, 100, 0);
      return renderResult({
        format: "markdown",
        title: `Deployment queue (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "The deployment queue is empty. Nothing is running or waiting.",
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((entry) => ({
            status: (entry.status as string) ?? "unknown",
            title: (entry.title as string) ?? "",
            deploymentId: (entry.deploymentId as string) ?? "—",
            createdAt: humanTime(entry.createdAt),
          }));
          return table(rows, [
            { key: "status", label: "Status" },
            { key: "title", label: "Title" },
            { key: "deploymentId", label: "deploymentId" },
            { key: "createdAt", label: "Queued" },
          ]);
        },
      });
    },
  );

  /* -------------------------------------------------------- killProcess */

  defineTool(
    server,
    context,
    "dokploy_kill_deployment",
    {
      title: "Kill A Running Deployment",
      description: `Kill a deployment that is running or hung.

Use this only for a run that is genuinely stuck — a build waiting on an input that will
never arrive, or a process wedged after a failure. Check dokploy_get_deployment_queue first:
if the run is \`pending\` rather than running, killing it achieves nothing.

Killing a run mid-build leaves the service on whatever image it already had. It does not
roll back, and it does not undo a partial deploy.

Set \`confirm: true\` — without it the tool refuses and kills nothing.

Args:
  - deploymentId (string, required): The deployment to kill
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: Dokploy's response, usually \`true\`

Examples:
  - Use when: a build has been "running" for hours with no log progress ->
    { deploymentId: "…", confirm: true }
  - Use when: a deploy is blocking the queue behind it
  - Don't use when: the deploy finished but the service is broken -> that is a different
    problem; kill and redeploy will not fix it

Error Handling:
  - 404 -> no deployment with that id
  - 400 -> the deployment has already finished; a finished run has no process to kill
  - The service keeps serving its current version unless the killed deploy had already
    replaced it`,
      inputSchema: z
        .object({
          deploymentId: IdSchema.describe("The deployment to kill"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async ({ deploymentId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `Killing deployment ${deploymentId} terminates a running build or deploy process. ` +
          "Anything it has already written stays, and the service is left on whatever version it " +
          "had before — there is no rollback.",
        "Read the deployment log with dokploy_get_deployment_logs to confirm it is actually stuck, then call it again with confirm: true.",
      );
      if (refusal) return refusal;

      const result = await context.client.mutation<unknown>("deployment.killProcess", {
        deploymentId,
      });
      return renderResult({
        format: "markdown",
        title: `Killed deployment ${deploymentId}`,
        structured: { deploymentId, killed: true, result },
        markdown: () =>
          [
            `- **deploymentId**: \`${deploymentId}\``,
            "- **Result**: killed",
            "- The service still runs whatever version was live before this deployment.",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------------- rollback */

  defineTool(
    server,
    context,
    "dokploy_rollback_deployment",
    {
      title: "Roll Back To An Earlier Deployment",
      description: `Redeploy a previous image over the current one.

This takes a **rollback record id**, not a deployment id. Dokploy's \`rollback.rollback\`
procedure is addressed by \`rollbackId\` — the id of a stored rollback entry that already
points at the image you want to return to. Passing a \`deploymentId\` here will fail, because
the two ids are different kinds of row.

v0.30.8 exposes no endpoint that lists rollback records, so this tool cannot discover the id
for you: it has to come from the service's page in the Dokploy UI, or from a rollback record
you already hold. If you do not have one, redeploying the previous git commit is the
practical equivalent and needs no rollback record.

Rolling back replaces the running image immediately and re-triggers Traefik, so requests to
the service can fail for a moment during the switch.

Set \`confirm: true\` — without it the tool refuses and rolls nothing back.

Args:
  - rollbackId (string, required): The id of the rollback record to restore. This is *not* a
    \`deploymentId\`.
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: Dokploy's response, usually \`true\`

Examples:
  - Use when: "put yesterday's build back" -> { rollbackId: "…", confirm: true }
  - Don't use when: you have a git commit to go back to -> redeploy that commit instead; it is
    repeatable and needs no rollback record
  - Don't use when: the last deploy simply failed halfway -> a completed deployment is usually
    safer than an image of unknown age

Error Handling:
  - 404 -> no rollback record with that id. A \`deploymentId\` sent here lands here too, which
    is the common mistake.
  - 400 -> the rollback record has no stored image, so there is nothing to restore
  - Rollback is a redeploy: it consumes a deployment slot and appears in
    dokploy_list_deployments like any other run`,
      inputSchema: z
        .object({
          rollbackId: z
            .string()
            .min(1)
            .describe("Id of the rollback record to restore. Not a deploymentId"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async ({ rollbackId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `Rolling back via ${rollbackId} replaces the image the service is running right now with ` +
          "an older one, and re-triggers Traefik, so requests to this service can fail during the " +
          "switch. Any configuration or data written since that image was built is not reverted.",
        "Confirm the rollbackId names a rollback record rather than a deployment id, then call it again with confirm: true.",
      );
      if (refusal) return refusal;

      const result = await context.client.mutation<unknown>("rollback.rollback", { rollbackId });
      return renderResult({
        format: "markdown",
        title: `Rolled back via ${rollbackId}`,
        structured: { rollbackId, rolledBack: true, result },
        markdown: () =>
          [
            `- **rollbackId**: \`${rollbackId}\``,
            "- **Result**: rollback requested",
            "- This runs as a new deployment; track it with dokploy_list_deployments.",
          ].join("\n"),
      });
    },
  );
}
