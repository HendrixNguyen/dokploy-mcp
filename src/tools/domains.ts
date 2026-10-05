/**
 * Domain and certificate tools.
 *
 * A Dokploy "domain" is one row in Traefik's router table: it binds a hostname (and
 * optionally a path) to a port on an application or a compose service, and decides whether
 * Traefik terminates TLS for it. Domains are therefore the live routing layer, not a label
 * on a service — deleting one takes the route down.
 *
 * The raw `domain.create` body is the worst shape in this API: sixteen fields, fifteen of
 * them optional, and three of those (`applicationId`/`composeId`/`domainType`) must agree
 * with each other or the route is silently created against the wrong target. `dokploy_create_domain`
 * takes a `target` + `targetId` pair and derives the rest, so that agreement is no longer
 * the agent's problem.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { humanTime, paginate, renderResult, table } from "../format.js";
import type { DomainRecord } from "../types.js";
import { ConfirmSchema, IdSchema, ResponseFormatSchema } from "../schemas/common.js";
import {
  defineTool,
  DESTRUCTIVE,
  READ_ONLY,
  requireConfirmation,
  WRITE,
  type ToolContext,
  type ToolResult,
} from "./registry.js";

const CERTIFICATE_TYPES = ["letsencrypt", "none", "custom"] as const;

/** Host column shared by both domain lists, so the two tools render identically. */
const DOMAIN_COLUMNS = [
  { key: "host", label: "Host" },
  { key: "port", label: "Port" },
  { key: "https", label: "HTTPS" },
  { key: "certificateType", label: "Certificate" },
  { key: "domainId", label: "domainId" },
] as const;

function domainRows(domains: DomainRecord[]): Record<string, unknown>[] {
  return domains.map((domain) => ({
    host: domain.host ?? "—",
    port: domain.port ?? "—",
    https: domain.https === true ? "yes" : "no",
    certificateType: domain.certificateType ?? "—",
    domainId: domain.domainId ?? "—",
  }));
}

/** `certificateType: "custom"` without a resolver name produces an unroutable TLS block. */
function certificateWarning(certificateType: string | undefined): string | undefined {
  if (certificateType === undefined) return undefined;
  if (certificateType === "custom") {
    return (
      "certificateType is `custom`, but this tool has no field for customCertResolver, so " +
      "Dokploy will store no resolver name. The route is created but TLS will not be issued " +
      "until one is set."
    );
  }
  return undefined;
}

export function registerDomains(server: McpServer, context: ToolContext): void {
  /* -------------------------------------------------------- validateDomain */

  defineTool(
    server,
    context,
    "dokploy_validate_domain",
    {
      title: "Check Whether A Domain Is Ready To Route",
      description: `Check that a hostname is ready to be routed before you create a domain for it.

Dokploy reports DNS readiness: whether \`domain\` resolves, and — when \`serverIp\` is given —
whether it resolves *to that address*. It checks nothing about the application itself, no
container is started and no route is created, so this is safe to call before every deploy.

Dokploy exposes this as a POST procedure, but it only reads: it is annotated read-only here
and refuses to change anything.

Args:
  - domain (string, required): The hostname to test, e.g. "api.example.com"
  - serverIp (string, optional): The IP the hostname is expected to point at. Supplying it
    turns the check into an A-record comparison rather than a bare "does it resolve".
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: Dokploy's readiness report, passed through verbatim, e.g.
  { "domain": "api.example.com", "resolved": true, "matchesServerIp": true }

Examples:
  - Use when: "will my new subdomain work?" -> { domain: "api.example.com" }
  - Use when: a route 404s right after the DNS record was added ->
    { domain: "api.example.com", serverIp: "203.0.113.10" }
  - Don't use when: you want to change routing -> use dokploy_create_domain

Error Handling:
  - 400 -> the hostname is malformed or has no DNS record at all
  - The procedure takes \`domain\` and \`serverIp\` only; there is no serverId parameter, so
    pass the instance's public IP rather than a Dokploy server id`,
      inputSchema: z
        .object({
          domain: z.string().min(1).describe("The hostname to test, e.g. api.example.com"),
          serverIp: z
            .string()
            .min(1)
            .optional()
            .describe("Expected IP. When given, the check also compares it against the A record"),
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ domain, serverIp }): Promise<ToolResult> => {
      // POST in Dokploy's spec, read-only in effect. `client.mutation` is correct here and
      // `client.query` would throw before the network call.
      const report = await context.client.mutation<Record<string, unknown>>(
        "domain.validateDomain",
        { domain, serverIp },
      );
      const structured = { domain, serverIp: serverIp ?? null, report };
      return renderResult({
        format: "markdown",
        title: `Domain readiness for ${domain}`,
        structured,
        markdown: () =>
          [
            `- **Domain**: \`${domain}\``,
            `- **Expected IP**: ${serverIp ?? "— (resolution only)"}`,
            "",
            "### Report",
            Object.keys(report ?? {}).length === 0
              ? "_Dokploy returned an empty report. Treat this as unverified._"
              : "```json\n" + JSON.stringify(report, null, 2) + "\n```",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------- list domains (both) */

  defineTool(
    server,
    context,
    "dokploy_list_application_domains",
    {
      title: "List An Application's Domains",
      description: `List every domain row attached to one application.

Args:
  - applicationId (string, required): The application id
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: the domain rows, e.g.
  [ { "domainId": "…", "host": "api.example.com", "port": 3000, "https": true,
      "certificateType": "letsencrypt", "applicationId": "…" } ]

Examples:
  - Use when: "what hostname does my API answer on?" -> pass the resolved applicationId
  - Use when: before changing a route -> read it here so you know the current port
  - Don't use when: the service is a compose stack -> use dokploy_list_compose_domains

Error Handling:
  - 404 -> wrong applicationId; resolve it with dokploy_resolve_service
  - An empty list is normal: a service reachable only on its IP has no domain rows`,
      inputSchema: z
        .object({
          applicationId: IdSchema.describe("The application id"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ applicationId, response_format }): Promise<ToolResult> => {
      const payload = await context.client.query<DomainRecord[]>("domain.byApplicationId", {
        applicationId,
      });
      const domains = Array.isArray(payload) ? payload : [];
      const page = paginate(domains, 100, 0);
      return renderResult({
        format: response_format,
        title: `Domains for application ${applicationId} (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `Application ${applicationId} has no domains configured.`,
        markdown: (data) =>
          table(domainRows((data as { items: DomainRecord[] }).items), DOMAIN_COLUMNS),
      });
    },
  );

  defineTool(
    server,
    context,
    "dokploy_list_compose_domains",
    {
      title: "List A Compose Stack's Domains",
      description: `List every domain row attached to one compose stack.

A compose stack often has several rows — one per service that should be reachable — so read
the \`serviceName\` on each row before changing it.

Args:
  - composeId (string, required): The compose stack id
  - response_format ('markdown' | 'json'): default 'markdown'

Returns: the domain rows, each carrying the \`serviceName\` it routes to, e.g.
  [ { "domainId": "…", "host": "app.example.com", "port": 8080, "serviceName": "web",
      "https": true, "certificateType": "letsencrypt" } ]

Examples:
  - Use when: "which compose service is example.com pointing at?" -> read \`serviceName\`
  - Use when: removing a route from a stack that has several
  - Don't use when: the service is an application -> use dokploy_list_application_domains

Error Handling:
  - 404 -> wrong composeId; resolve it with dokploy_resolve_service`,
      inputSchema: z
        .object({
          composeId: IdSchema.describe("The compose stack id"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: READ_ONLY,
    },
    async ({ composeId, response_format }): Promise<ToolResult> => {
      const payload = await context.client.query<DomainRecord[]>("domain.byComposeId", { composeId });
      const domains = Array.isArray(payload) ? payload : [];
      const page = paginate(domains, 100, 0);
      return renderResult({
        format: response_format,
        title: `Domains for compose ${composeId} (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: `Compose ${composeId} has no domains configured.`,
        markdown: (data) => {
          const items = (data as { items: DomainRecord[] }).items;
          const rows = domainRows(items).map((row, index) => ({
            ...row,
            serviceName: items[index]?.serviceName ?? "—",
          }));
          return table(rows, [
            { key: "host", label: "Host" },
            { key: "port", label: "Port" },
            { key: "serviceName", label: "Service" },
            { key: "https", label: "HTTPS" },
            { key: "certificateType", label: "Certificate" },
            { key: "domainId", label: "domainId" },
          ]);
        },
      });
    },
  );

  /* --------------------------------------------------------- createDomain */

  defineTool(
    server,
    context,
    "dokploy_create_domain",
    {
      title: "Route A Hostname To An Application Or Compose Service",
      description: `Create a domain row: bind a hostname (and optionally a path) to a port on a
service, and have Traefik terminate TLS for it.

This tool is deliberately narrower than \`domain.create\`. The raw endpoint accepts sixteen
fields and expects \`applicationId\`, \`composeId\` and \`domainType\` to agree; here you name a
\`target\` and its \`targetId\` and the tool derives all three, so a route cannot be created
against the wrong service.

Set \`confirm: true\` — without it the tool refuses and creates nothing.

Args:
  - target ('application' | 'compose', required): Which kind of service this route points at.
    Decides whether \`applicationId\` or \`composeId\` is sent, and sets \`domainType\` to match.
  - targetId (string, required): The applicationId or composeId, per \`target\`
  - serviceName (string, required when target is 'compose'): The compose service the route
    lands on. Required for compose, rejected for application — an application domain has no
    service to name.
  - host (string, required): The hostname, e.g. "api.example.com". Traefik matches on this
    string, so use the bare hostname with no scheme, path or trailing slash.
  - port (number, optional): The container port to forward to, 1-65535. Omit to leave the
    route on whatever Dokploy defaults to.
  - https (boolean, optional, default true): Have Traefik serve this host over TLS
  - certificateType ('letsencrypt' | 'none' | 'custom', optional, default 'letsencrypt'):
    How the certificate is obtained. 'none' serves plain HTTP even when https is true.
  - stripPath (boolean, optional, default false): Strip the matched path prefix before
    forwarding. Leave false unless the app is mounted under a subpath and cannot strip it
    itself.
  - middlewares (string[], optional): Traefik middlewares to attach, e.g.
    ["authelia@docker", "compress"]. Passed through verbatim; a name Traefik does not know
    will fail the route reload.
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: the created domain row, including its new \`domainId\`

Examples:
  - Use when: "put api.example.com on the API app" ->
    { target: "application", targetId: "…", host: "api.example.com", port: 3000, confirm: true }
  - Use when: "expose the web service of the stack" ->
    { target: "compose", targetId: "…", serviceName: "web", host: "app.example.com", confirm: true }
  - Don't use when: the hostname already has a row -> use dokploy_update_domain, which does
    not create a second route for the same host

Error Handling:
  - 400 -> the host is already routed, or \`middlewares\` names an unknown Traefik middleware
  - 404 -> the target id does not exist; resolve it with dokploy_resolve_service
  - \`certificateType: 'custom'\` is accepted but no resolver name can be sent through this
    tool, so the certificate will not be issued until you set one in the Dokploy UI
  - Requires the service to exist first — this creates routing, not the service behind it`,
      inputSchema: z
        .object({
          target: z
            .enum(["application", "compose"])
            .describe(
              "Which kind of service this route targets. Decides applicationId vs composeId " +
                "and sets domainType to match",
            ),
          targetId: z
            .string()
            .min(1)
            .describe("The applicationId or composeId, according to `target`"),
          serviceName: z
            .string()
            .min(1)
            .optional()
            .describe("Compose service to route to. Required when target is 'compose'"),
          host: z
            .string()
            .min(1)
            .describe("Bare hostname with no scheme, path or trailing slash, e.g. api.example.com"),
          port: z
            .number()
            .int()
            .min(1)
            .max(65535)
            .optional()
            .describe("Container port to forward to (1-65535). Omit for the Dokploy default"),
          https: z
            .boolean()
            .default(true)
            .describe("Have Traefik terminate TLS for this host. Default true"),
          certificateType: z
            .enum(CERTIFICATE_TYPES)
            .default("letsencrypt")
            .describe("How the certificate is obtained. Default 'letsencrypt'"),
          stripPath: z
            .boolean()
            .default(false)
            .describe("Strip the matched path prefix before forwarding. Default false"),
          middlewares: z
            .array(z.string().min(1))
            .optional()
            .describe("Traefik middleware names to attach, e.g. [\"authelia@docker\"]"),
          confirm: ConfirmSchema,
        })
        .strict()
        .superRefine((input, ctx) => {
          // A compose domain without a service name cannot be routed: Traefik would be told
          // to forward to a container it cannot name.
          if (input.target === "compose" && !input.serviceName) {
            ctx.addIssue({
              code: "custom",
              path: ["serviceName"],
              message: "serviceName is required when target is 'compose'",
            });
          }
        }),
      annotations: WRITE,
    },
    async (input): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        input.confirm,
        `Creating domain "${input.host}" routes that hostname to ${input.target} ${input.targetId}` +
          (input.serviceName ? ` service "${input.serviceName}"` : "") +
          ". The hostname starts serving this service immediately, and an existing route on " +
          "the same host may be replaced.",
        "Call it again with confirm: true once you are sure that is the host and target you want.",
      );
      if (refusal) return refusal;

      // `forwardAuthEnabled: false` is sent explicitly rather than omitted: the raw body is a
      // strict schema with three non-nullable booleans, and omitting one is less predictable
      // than stating the intent.
      const body: Record<string, unknown> = {
        host: input.host,
        https: input.https,
        certificateType: input.certificateType,
        stripPath: input.stripPath,
        forwardAuthEnabled: false,
        domainType: input.target,
        [input.target === "application" ? "applicationId" : "composeId"]: input.targetId,
      };
      if (input.port !== undefined) body.port = input.port;
      if (input.serviceName !== undefined) body.serviceName = input.serviceName;
      if (input.middlewares !== undefined) body.middlewares = input.middlewares;

      const created = await context.client.mutation<DomainRecord>("domain.create", body);
      const warning = certificateWarning(input.certificateType);
      const structured = { domain: created, derived: body };

      return renderResult({
        format: "markdown",
        title: `Created domain ${input.host}`,
        structured,
        markdown: () =>
          [
            `- **Host**: \`${input.host}\``,
            `- **Target**: ${input.target} \`${input.targetId}\``,
            ...(input.serviceName ? [`- **Service**: \`${input.serviceName}\``] : []),
            `- **Port**: ${input.port ?? "Dokploy default"}`,
            `- **HTTPS**: ${input.https ? "yes" : "no"}`,
            `- **Certificate**: ${input.certificateType}`,
            `- **domainId**: \`${created?.domainId ?? "not returned"}\``,
            "",
            "### Fields this tool derived",
            "```json\n" + JSON.stringify(body, null, 2) + "\n```",
            ...(warning ? ["", `_Note: ${warning}_`] : []),
          ].join("\n"),
      });
    },
  );

  /* --------------------------------------------------------- updateDomain */

  defineTool(
    server,
    context,
    "dokploy_update_domain",
    {
      title: "Change An Existing Domain Route",
      description: `Change an existing domain row in place: its port, TLS settings, path handling
or attached middlewares.

Read the current values with dokploy_list_application_domains or
dokploy_list_compose_domains first. \`host\` and \`domainId\` are required by the endpoint, and
the row is replaced by what you send — the port is not "patched", so an omitted \`port\` is
saved as Dokploy's default rather than left alone.

The target service cannot be moved here: \`domain.update\` takes no \`applicationId\` or
\`composeId\`. To repoint a route, delete the row and create a new one.

Set \`confirm: true\` — without it the tool refuses and changes nothing.

Args:
  - domainId (string, required): The domain row to change
  - host (string, required): The hostname this row serves. Required by the endpoint even when
    it is not changing, so pass the current value.
  - port (number, optional): New container port, 1-65535
  - https (boolean, optional, default true): Terminate TLS for this host
  - certificateType ('letsencrypt' | 'none' | 'custom', optional, default 'letsencrypt'):
    How the certificate is obtained
  - stripPath (boolean, optional, default false): Strip the matched path prefix before forwarding
  - middlewares (string[], optional): Replaces the attached middleware list wholesale
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: the updated domain row

Examples:
  - Use when: "the app moved to port 8080" -> { domainId: "…", host: "api.example.com", port: 8080 }
  - Use when: "turn off TLS on the staging host" -> { domainId: "…", host: "staging.example.com",
    https: false, certificateType: "none" }
  - Don't use when: the route needs to point at a different service -> delete and recreate,
    because this endpoint cannot move a domain between services

Error Handling:
  - 404 -> no domain row with that id
  - 400 -> \`middlewares\` names an unknown Traefik middleware, or the new port conflicts`,
      inputSchema: z
        .object({
          domainId: IdSchema.describe("The domain row to change"),
          host: z
            .string()
            .min(1)
            .describe("The hostname this row serves. Required even when unchanged"),
          port: z.number().int().min(1).max(65535).optional().describe("New container port"),
          https: z.boolean().default(true).describe("Terminate TLS for this host. Default true"),
          certificateType: z
            .enum(CERTIFICATE_TYPES)
            .default("letsencrypt")
            .describe("How the certificate is obtained. Default 'letsencrypt'"),
          stripPath: z
            .boolean()
            .default(false)
            .describe("Strip the matched path prefix before forwarding. Default false"),
          middlewares: z
            .array(z.string().min(1))
            .optional()
            .describe("Replaces the attached Traefik middleware list"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: WRITE,
    },
    async (input): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        input.confirm,
        `Updating domain ${input.domainId} rewrites the live route for "${input.host}"` +
          (input.port !== undefined ? ` to forward to port ${input.port}` : "") +
          `. A TLS change reloads Traefik, so any in-flight request to this host can fail.`,
        "Call it again with confirm: true once you have read the current values and mean to replace them.",
      );
      if (refusal) return refusal;

      const body: Record<string, unknown> = {
        domainId: input.domainId,
        host: input.host,
        https: input.https,
        certificateType: input.certificateType,
        stripPath: input.stripPath,
        forwardAuthEnabled: false,
      };
      if (input.port !== undefined) body.port = input.port;
      if (input.middlewares !== undefined) body.middlewares = input.middlewares;

      const updated = await context.client.mutation<DomainRecord>("domain.update", body);
      const warning = certificateWarning(input.certificateType);
      return renderResult({
        format: "markdown",
        title: `Updated domain ${input.host}`,
        structured: { domain: updated, sent: body },
        markdown: () =>
          [
            `- **Host**: \`${input.host}\``,
            `- **domainId**: \`${input.domainId}\``,
            `- **Port**: ${input.port ?? "Dokploy default"}`,
            `- **HTTPS**: ${input.https ? "yes" : "no"}`,
            `- **Certificate**: ${input.certificateType}`,
            "",
            "```json\n" + JSON.stringify(updated ?? body, null, 2) + "\n```",
            ...(warning ? ["", `_Note: ${warning}_`] : []),
          ].join("\n"),
      });
    },
  );

  /* --------------------------------------------------------- deleteDomain */

  defineTool(
    server,
    context,
    "dokploy_delete_domain",
    {
      title: "Remove A Domain Route",
      description: `Delete a domain row, taking the route down.

This is destructive and immediate: requests to the hostname stop being proxied the moment
the row is gone. There is no undo — to bring the route back you must create the domain
again, and the new row gets a new \`domainId\`.

Set \`confirm: true\` — without it the tool refuses and deletes nothing.

Args:
  - domainId (string, required): The domain row to delete
  - confirm (boolean, required): Must be true or the tool refuses without calling Dokploy

Returns: Dokploy's response, usually \`true\`

Examples:
  - Use when: "take staging.example.com offline" -> { domainId: "…", confirm: true }
  - Use when: a route points at a service that no longer exists
  - Don't use when: you only want different routing -> use dokploy_update_domain, which keeps
    the row and its id

Error Handling:
  - 404 -> no domain row with that id; list the service's domains to find the right one
  - The service itself is untouched: deleting a domain does not stop the application`,
      inputSchema: z
        .object({
          domainId: IdSchema.describe("The domain row to delete"),
          confirm: ConfirmSchema,
        })
        .strict(),
      annotations: DESTRUCTIVE,
    },
    async ({ domainId, confirm }): Promise<ToolResult> => {
      const refusal = requireConfirmation(
        confirm,
        `Deleting domain ${domainId} removes the live Traefik route. Requests to that hostname ` +
          "will stop being proxied immediately and there is no undo — recreating it produces a " +
          "new domainId, and any TLS certificate issued for it is reissued from scratch.",
        "Confirm the domainId with dokploy_list_application_domains or dokploy_list_compose_domains first, then call it again with confirm: true.",
      );
      if (refusal) return refusal;

      const result = await context.client.mutation<unknown>("domain.delete", { domainId });
      return renderResult({
        format: "markdown",
        title: `Deleted domain ${domainId}`,
        structured: { domainId, deleted: true, result },
        markdown: () =>
          [
            `- **domainId**: \`${domainId}\``,
            "- **Result**: deleted",
            "- The hostname no longer routes to this instance. The service behind it still runs.",
          ].join("\n"),
      });
    },
  );

  /* ------------------------------------------------------- certificates.all */

  defineTool(
    server,
    context,
    "dokploy_list_certificates",
    {
      title: "List TLS Certificates",
      description: `List every TLS certificate Dokploy has issued or is holding for this instance.

Useful before creating a domain with \`certificateType: 'custom'\`, and when a host is
serving a certificate for the wrong name — a stale certificate here explains that.

Args: none

Returns: the certificate rows, e.g.
  [ { "certificateId": "…", "host": "api.example.com", "provider": "letsencrypt",
      "createdAt": "2026-09-01T…", "certificateData": "…" } ]

Examples:
  - Use when: "which certs does this instance hold?" -> the whole list
  - Use when: a host serves the wrong certificate -> match \`host\` here
  - Don't use when: you need the routing table -> use dokploy_list_application_domains, which
    is what decides which certificate a host actually gets

Error Handling:
  - An empty list is normal on an instance that only uses Let's Encrypt, where certificates are
    managed per-domain rather than stored here`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async (): Promise<ToolResult> => {
      const payload = await context.client.query<unknown>("certificates.all");
      const items = Array.isArray(payload) ? payload : ((payload as { items?: unknown[] })?.items ?? []);
      const page = paginate(items as Record<string, unknown>[], 100, 0);
      return renderResult({
        format: "markdown",
        title: `Certificates (${page.count})`,
        structured: page,
        isEmpty: (data) => (data as { items: unknown[] }).items.length === 0,
        empty: "This instance holds no custom certificates.",
        markdown: (data) => {
          const rows = (data as { items: Record<string, unknown>[] }).items.map((cert) => ({
            host: (cert.host as string) ?? (cert.domain as string) ?? "—",
            provider: (cert.provider as string) ?? (cert.certificateType as string) ?? "—",
            certificateId: (cert.certificateId as string) ?? (cert.id as string) ?? "—",
            createdAt: humanTime(cert.createdAt),
          }));
          return table(rows, [
            { key: "host", label: "Host" },
            { key: "provider", label: "Provider" },
            { key: "certificateId", label: "certificateId" },
            { key: "createdAt", label: "Created" },
          ]);
        },
      });
    },
  );
}
