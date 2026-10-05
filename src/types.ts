/**
 * Shared response shapes, transcribed from the pinned spec (docs/openapi.v0.30.8.json)
 * and confirmed against live responses from a v0.30.8 instance.
 *
 * Dokploy's spec declares response bodies as bare `object` with no properties, so these
 * interfaces are the actual contract. Fields are typed as optional wherever a value was
 * observed to be nullable rather than absent.
 */

/** Every service kind Dokploy manages. The six database engines share one tool set. */
export const SERVICE_TYPES = [
  "application",
  "compose",
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

/** The six engines addressed by a `<type>.<verb>` procedure. */
export const DATABASE_TYPES = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
] as const;

export type DatabaseType = (typeof DATABASE_TYPES)[number];

export function isDatabaseType(value: string): value is DatabaseType {
  return (DATABASE_TYPES as readonly string[]).includes(value);
}

/**
 * Dokploy's paginated envelope, exactly as returned. Note it carries no `has_more` or
 * `next_offset`; `format.paginate` derives those.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
}

/** A zod validation issue, surfaced verbatim so the agent can self-correct. */
export interface DokployIssue {
  expected?: string;
  code?: string;
  path?: (string | number)[];
  message?: string;
}

export interface DokployZodError {
  formErrors?: string[];
  fieldErrors?: Record<string, string[] | undefined>;
}

export interface DokployErrorBody {
  message?: string;
  code?: string;
  data?: {
    code?: string;
    httpStatus?: number;
    path?: string;
    zodError?: DokployZodError | null;
  };
  issues?: DokployIssue[];
}

/* ------------------------------------------------------------------ projects */

export interface ProjectTreeService {
  applicationId?: string;
  composeId?: string;
  postgresId?: string;
  mysqlId?: string;
  mariadbId?: string;
  mongoId?: string;
  redisId?: string;
  libsqlId?: string;
  name?: string;
  appName?: string;
  applicationStatus?: string;
  composeStatus?: string;
  [key: string]: unknown;
}

export interface ProjectEnvironment {
  name?: string;
  environmentId?: string;
  isDefault?: boolean;
  applications?: ProjectTreeService[];
  compose?: ProjectTreeService[];
  postgres?: ProjectTreeService[];
  mysql?: ProjectTreeService[];
  mariadb?: ProjectTreeService[];
  mongo?: ProjectTreeService[];
  redis?: ProjectTreeService[];
  libsql?: ProjectTreeService[];
}

export interface Project {
  projectId: string;
  name?: string;
  description?: string | null;
  createdAt?: string;
  organizationId?: string;
  environments?: ProjectEnvironment[];
  projectTags?: unknown[];
}

export interface ProjectSummary {
  projectId: string;
  name?: string;
  description?: string | null;
  createdAt?: string;
}

/* ------------------------------------------------------------------- search */

export interface ApplicationSummary {
  applicationId: string;
  name?: string;
  appName?: string;
  description?: string | null;
  environmentId?: string;
  applicationStatus?: string;
  sourceType?: string;
  createdAt?: string;
}

export interface ComposeSummary {
  composeId: string;
  name?: string;
  appName?: string;
  description?: string | null;
  environmentId?: string;
  composeStatus?: string;
  sourceType?: string;
  createdAt?: string;
}

/** Normalised row returned by the resolve/describe tools across all service types. */
export interface ResolvedService {
  type: ServiceType;
  id: string;
  name?: string;
  appName?: string;
  status?: string;
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
}

/* -------------------------------------------------------------- deployments */

export interface Deployment {
  deploymentId: string;
  title?: string;
  description?: string | null;
  status?: string;
  logPath?: string | null;
  pid?: number | null;
  applicationId?: string | null;
  composeId?: string | null;
  serverId?: string | null;
  isPreviewDeployment?: boolean;
  previewDeploymentId?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/* -------------------------------------------------------------------- misc */

export interface SessionInfo {
  user?: { id?: string };
  session?: { activeOrganizationId?: string };
}

export interface ServerSummary {
  serverId: string;
  name?: string;
  ip?: string;
  [key: string]: unknown;
}

/**
 * Row shape returned by `docker.getContainers`, observed on a v0.30.8 instance.
 * Dokploy re-keys Docker's native PascalCase fields into snake_case, so these are Dokploy's
 * names and not Docker's.
 */
export interface ContainerSummary {
  containerId?: string;
  name?: string;
  image?: string;
  /** Host-published port mappings as a preformatted string; empty when none. */
  ports?: string;
  state?: string;
  /** Human uptime/status text, e.g. "Up 19 hours". */
  status?: string;
  /** Docker's native spellings, declared so fallbacks stay typed rather than `unknown`. */
  IdShort?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  [key: string]: unknown;
}

export interface DomainRecord {
  domainId?: string;
  host?: string;
  port?: number;
  https?: boolean;
  certificateType?: string;
  applicationId?: string | null;
  composeId?: string | null;
  serviceName?: string | null;
  path?: string | null;
  domainType?: string | null;
  [key: string]: unknown;
}
