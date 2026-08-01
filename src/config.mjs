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
  });
}

