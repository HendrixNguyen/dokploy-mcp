/**
 * Zod schemas for the six Dokploy database engines.
 *
 * Each engine has a different `create` contract, so the create schema is a
 * discriminated union on `type`. Update, delete and the other verbs all share the
 * same shape: the engine-specific id plus optional fields.
 */

import { z } from "zod";
import {
  AppNameSchema,
  IdSchema,
  PasswordSchema,
} from "./common.js";
import { DATABASE_TYPES, type DatabaseType } from "../types.js";

export type { DatabaseType };

/* ------------------------------------------------------------------ types */

export const DatabaseTypeSchema = z.enum(DATABASE_TYPES);

const EnvironmentIdSchema = z.string().describe("The environment id");
const ServerIdSchema = z.string().nullable().optional().describe("Server id, or null for the default host");
const DescriptionSchema = z.string().nullable().optional().describe("Human description, or null");

/* ------------------------------------------------------------- create shapes */

const PostgresCreateSchema = z.object({
  type: z.literal("postgres"),
  name: z.string().min(1).describe("Service name"),
  // Optional in the spec for every engine except libsql: Dokploy auto-generates it.
  appName: AppNameSchema.optional(),
  databaseName: z.string().min(1).describe("Database name"),
  databaseUser: z.string().min(1).describe("Database user"),
  databasePassword: PasswordSchema,
  environmentId: EnvironmentIdSchema,
  dockerImage: z
    .string()
    .default("postgres:18")
    .describe("Docker image (default postgres:18)"),
  description: DescriptionSchema,
  serverId: ServerIdSchema,
});

const MysqlCreateSchema = z.object({
  type: z.literal("mysql"),
  name: z.string().min(1).describe("Service name"),
  // Optional in the spec for every engine except libsql: Dokploy auto-generates it.
  appName: AppNameSchema.optional(),
  dockerImage: z
    .string()
    .default("mysql:8")
    .describe("Docker image (default mysql:8)"),
  databaseName: z.string().min(1).describe("Database name"),
  databaseUser: z.string().min(1).describe("Database user"),
  databasePassword: PasswordSchema,
  databaseRootPassword: PasswordSchema.optional().describe("Root password, if required"),
  environmentId: EnvironmentIdSchema,
  description: DescriptionSchema,
  serverId: ServerIdSchema,
});

const MariadbCreateSchema = z.object({
  type: z.literal("mariadb"),
  name: z.string().min(1).describe("Service name"),
  // Optional in the spec for every engine except libsql: Dokploy auto-generates it.
  appName: AppNameSchema.optional(),
  dockerImage: z
    .string()
    .default("mariadb:6")
    .describe("Docker image (default mariadb:6)"),
  databaseName: z.string().min(1).describe("Database name"),
  databaseUser: z.string().min(1).describe("Database user"),
  databasePassword: PasswordSchema,
  databaseRootPassword: PasswordSchema.optional().describe("Root password, if required"),
  environmentId: EnvironmentIdSchema,
  description: DescriptionSchema,
  serverId: ServerIdSchema,
});

const MongoCreateSchema = z.object({
  type: z.literal("mongo"),
  name: z.string().min(1).describe("Service name"),
  // Optional in the spec for every engine except libsql: Dokploy auto-generates it.
  appName: AppNameSchema.optional(),
  dockerImage: z
    .string()
    .default("mongo:15")
    .describe("Docker image (default mongo:15)"),
  databaseUser: z.string().min(1).describe("Database user"),
  databasePassword: PasswordSchema,
  replicaSets: z.boolean().default(false).optional().describe("Enable replica sets"),
  environmentId: EnvironmentIdSchema,
  description: DescriptionSchema,
  serverId: ServerIdSchema,
});

const RedisCreateSchema = z.object({
  type: z.literal("redis"),
  name: z.string().min(1).describe("Service name"),
  // Optional in the spec for every engine except libsql: Dokploy auto-generates it.
  appName: AppNameSchema.optional(),
  databasePassword: PasswordSchema,
  dockerImage: z
    .string()
    .default("redis:8")
    .describe("Docker image (default redis:8)"),
  environmentId: EnvironmentIdSchema,
  description: DescriptionSchema,
  serverId: ServerIdSchema,
});

const LibsqlCreateSchema = z.object({
  type: z.literal("libsql"),
  name: z.string().min(1).describe("Service name"),
  appName: AppNameSchema,
  dockerImage: z
    .string()
    .default("ghcr.io/tursodatabase/libsql-server:v0.24.32")
    .describe("Docker image (default ghcr.io/tursodatabase/libsql-server:v0.24.32)"),
  environmentId: EnvironmentIdSchema,
  description: DescriptionSchema,
  databaseUser: z.string().min(1).describe("Database user"),
  databasePassword: PasswordSchema,
  sqldNode: z.enum(["primary", "replica"]).describe("SQLD node role"),
  sqldPrimaryUrl: z
    .string()
    .nullable()
    .describe("Primary URL for replica mode, or null for primary"),
  enableNamespaces: z.boolean().default(false).describe("Enable libsql namespaces"),
  // Required by the spec for libsql, unlike every other engine.
  serverId: z.string().describe("Server id (required by Dokploy for libsql)"),
});

export const DatabaseCreateSchema = z.discriminatedUnion("type", [
  PostgresCreateSchema,
  MysqlCreateSchema,
  MariadbCreateSchema,
  MongoCreateSchema,
  RedisCreateSchema,
  LibsqlCreateSchema,
]);

export type DatabaseCreateInput = z.infer<typeof DatabaseCreateSchema>;

/* ------------------------------------------------------------- update shape */

/**
 * Update payloads are per-engine but share the same pattern: the engine-specific
 * id is required, every other field is optional. We accept `type` plus passthrough
 * and validate the id key in the handler so the zod schema stays engine-agnostic.
 */
export const DatabaseUpdateSchema = z.object({
  type: DatabaseTypeSchema,
}).passthrough();

/* ------------------------------------------------------------- id key map */

/**
 * Maps each engine to the id field name its procedures expect.
 *
 * This is the highest-risk mapping in the codebase: every tool dispatches
 * `${type}.${verb}` and passes the id under this key. A typo here silently
 * calls the wrong procedure or produces a 400 from Dokploy.
 */
export const DATABASE_ID_KEY: Record<DatabaseType, string> = {
  postgres: "postgresId",
  mysql: "mysqlId",
  mariadb: "mariadbId",
  mongo: "mongoId",
  redis: "redisId",
  libsql: "libsqlId",
};

/* ------------------------------------------------------------- changePassword */

const PostgresChangePasswordSchema = z.object({
  type: z.literal("postgres"),
  postgresId: IdSchema,
  password: PasswordSchema,
});

const MariadbChangePasswordSchema = z.object({
  type: z.literal("mariadb"),
  mariadbId: IdSchema,
  password: PasswordSchema,
});

const MongoChangePasswordSchema = z.object({
  type: z.literal("mongo"),
  mongoId: IdSchema,
  password: PasswordSchema,
});

const RedisChangePasswordSchema = z.object({
  type: z.literal("redis"),
  redisId: IdSchema,
  password: PasswordSchema,
});

const MysqlChangePasswordSchema = z.object({
  type: z.literal("mysql"),
  mysqlId: IdSchema,
  password: PasswordSchema,
  passwordType: z.enum(["user", "root"]).default("user").optional().describe("user or root (default user)"),
});

export const DatabaseChangePasswordSchema = z.discriminatedUnion("type", [
  PostgresChangePasswordSchema,
  MariadbChangePasswordSchema,
  MongoChangePasswordSchema,
  RedisChangePasswordSchema,
  MysqlChangePasswordSchema,
]);

/* ------------------------------------------------------------- external port */

/**
 * Standard engines (postgres, mysql, mariadb, mongo, redis) all use the singular
 * `saveExternalPort` verb with `{ <type>Id, externalPort }`. The id key is
 * resolved in the handler from `DATABASE_ID_KEY[type]`.
 */
export const DatabaseExternalPortSchema = z.object({
  type: DatabaseTypeSchema,
  externalPort: z.number().nullable().describe("External port number, or null to unset"),
}).passthrough();
