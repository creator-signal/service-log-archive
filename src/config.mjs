import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const integer = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

export async function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.LOG_ARCHIVE_DATA_DIR || "/var/lib/log-archive/state");
  const spoolDir = path.resolve(env.LOG_ARCHIVE_SPOOL_DIR || "/var/lib/log-archive/spool");
  const archiveDir = path.resolve(env.LOG_ARCHIVE_ARCHIVE_DIR || "/var/lib/log-archive/archive");
  const roots = (env.LOG_ARCHIVE_ALLOWED_ROOTS || "/logs")
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));

  if (roots.length === 0) throw new Error("LOG_ARCHIVE_ALLOWED_ROOTS must contain at least one path");

  await Promise.all([dataDir, spoolDir, archiveDir, ...roots].map((directory) => mkdir(directory, { recursive: true })));
  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
  const s3Endpoint = env.LOG_ARCHIVE_S3_ENDPOINT?.replace(/\/$/, "") || "";
  const s3Bucket = env.LOG_ARCHIVE_S3_BUCKET || "";
  const s3Prefix = (env.LOG_ARCHIVE_S3_PREFIX || "log-archive").replace(/^\/+|\/+$/g, "");
  if (s3Endpoint) {
    const endpoint = new URL(s3Endpoint);
    if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("LOG_ARCHIVE_S3_ENDPOINT must use HTTP or HTTPS");
    if (!s3Bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3Bucket)) throw new Error("LOG_ARCHIVE_S3_BUCKET is required and must be a valid bucket name");
    if (!env.LOG_ARCHIVE_S3_ACCESS_KEY_FILE || !env.LOG_ARCHIVE_S3_SECRET_KEY_FILE) throw new Error("S3 credentials must use access-key and secret-key files");
    if (s3Prefix.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("LOG_ARCHIVE_S3_PREFIX is invalid");
  }

  return Object.freeze({
    host: env.LOG_ARCHIVE_HOST || "0.0.0.0",
    port: integer(env.LOG_ARCHIVE_PORT, 8080),
    dataDir,
    spoolDir,
    archiveDir,
    allowedRoots: canonicalRoots,
    tokenFile: env.LOG_ARCHIVE_TOKEN_FILE || "/run/secrets/log-archive-api-tokens.json",
    oidcIssuer: env.LOG_ARCHIVE_OIDC_ISSUER?.replace(/\/$/, "") || "",
    oidcAudience: env.LOG_ARCHIVE_OIDC_AUDIENCE || "",
    oidcRoleClaim: env.LOG_ARCHIVE_OIDC_ROLE_CLAIM || "log_archive_role",
    schedulerIntervalMs: integer(env.LOG_ARCHIVE_SCHEDULER_INTERVAL_SECONDS, 15) * 1000,
    spoolMaxBytes: integer(env.LOG_ARCHIVE_SPOOL_MAX_BYTES, 1024 * 1024 * 1024),
    historyLimit: integer(env.LOG_ARCHIVE_HISTORY_LIMIT, 500),
    requestMaxBytes: integer(env.LOG_ARCHIVE_REQUEST_MAX_BYTES, 64 * 1024),
    rateLimitPerMinute: integer(env.LOG_ARCHIVE_RATE_LIMIT_PER_MINUTE, 120),
    s3: Object.freeze({
      enabled: Boolean(s3Endpoint),
      endpoint: s3Endpoint,
      bucket: s3Bucket,
      prefix: s3Prefix,
      region: env.LOG_ARCHIVE_S3_REGION || "us-east-1",
      accessKeyFile: env.LOG_ARCHIVE_S3_ACCESS_KEY_FILE || "",
      secretKeyFile: env.LOG_ARCHIVE_S3_SECRET_KEY_FILE || "",
    }),
  });
}

