import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export function createLogArchiveServer({ config, store, auth, engine, logger = console }) {
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  return createServer(async (request, response) => {
    const correlationId = request.headers["x-correlation-id"]?.slice(0, 100) || randomUUID();
    applyHeaders(response, correlationId);
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (!limiter.accept(request.socket.remoteAddress || "unknown")) return sendProblem(response, 429, "rate_limit", "Request rate limit exceeded");

      if (request.method === "GET" && url.pathname === "/livez") return sendJson(response, 200, { status: "live" });
      if (request.method === "GET" && url.pathname === "/readyz") {
        return sendJson(response, 200, { status: "ready", stateRevision: store.snapshot().revision });
      }
      if (request.method === "GET" && staticFiles.has(url.pathname)) return sendStatic(response, url.pathname);

      const identity = await auth.authenticate(request.headers.authorization);
      if (!identity) return sendProblem(response, 401, "unauthorized", "A valid bearer credential is required");

      if (request.method === "GET" && url.pathname === "/api/v1/status") {
        if (!auth.authorize(identity, "viewer")) return forbidden(response);
        return sendJson(response, 200, await engine.status());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/sources") {
        if (!auth.authorize(identity, "viewer")) return forbidden(response);
        return sendJson(response, 200, { items: await engine.listSources() });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/sources") {
        if (!auth.authorize(identity, "administrator")) return forbidden(response);
        return sendJson(response, 201, await engine.createSource(await body(request, config.requestMaxBytes), identity.subject, correlationId));
      }
      const sourceRoute = url.pathname.match(/^\/api\/v1\/sources\/([a-z][a-z0-9-]{1,62})$/);
      if (sourceRoute && request.method === "PUT") {
        if (!auth.authorize(identity, "administrator")) return forbidden(response);
        return sendJson(response, 200, await engine.updateSource(sourceRoute[1], await body(request, config.requestMaxBytes), identity.subject, correlationId));
      }
      if (sourceRoute && request.method === "DELETE") {
        if (!auth.authorize(identity, "administrator")) return forbidden(response);
        await engine.deleteSource(sourceRoute[1], identity.subject, correlationId);
        response.writeHead(204).end();
        return;
      }
      const rotateRoute = url.pathname.match(/^\/api\/v1\/sources\/([a-z][a-z0-9-]{1,62})\/rotate$/);
      if (rotateRoute && request.method === "POST") {
        if (!auth.authorize(identity, "operator")) return forbidden(response);
        return sendJson(response, 202, await engine.rotate(rotateRoute[1], identity.subject, "manual", correlationId));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/archive/retry") {
        if (!auth.authorize(identity, "operator")) return forbidden(response);
        return sendJson(response, 202, { items: await engine.retryPending(identity.subject, correlationId) });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/restore-verifications") {
        if (!auth.authorize(identity, "operator")) return forbidden(response);
        return sendJson(response, 201, await engine.verifyRestore(identity.subject, correlationId));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/audit") {
        if (!auth.authorize(identity, "viewer")) return forbidden(response);
        return sendJson(response, 200, { items: store.snapshot().audit.slice(-200).reverse() });
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        if (!auth.authorize(identity, "viewer")) return forbidden(response);
        return sendMetrics(response, await engine.status());
      }
      return sendProblem(response, 404, "not_found", "Route not found");
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) logger.error(JSON.stringify({ level: "error", event: "request.failed", correlationId, message: error.message }));
      return sendProblem(response, status, status === 500 ? "internal_error" : "request_rejected", status === 500 ? "Request failed" : error.message);
    }
  });
}

async function body(request, maximum) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.startsWith("application/json")) throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

async function sendStatic(response, route) {
  const [file, contentType] = staticFiles.get(route);
  const contents = await readFile(path.join(publicDirectory, file));
  response.writeHead(200, { "content-type": contentType, "cache-control": route === "/" ? "no-store" : "public, max-age=3600" });
  response.end(contents);
}

function sendJson(response, status, document) {
  const payload = JSON.stringify(document);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  response.end(payload);
}

function sendProblem(response, status, code, detail) {
  return sendJson(response, status, { type: `https://service-log-archive.dev/problems/${code}`, title: code, status, detail });
}

const forbidden = (response) => sendProblem(response, 403, "forbidden", "The credential does not have the required capability");

function sendMetrics(response, status) {
  const lines = [
    "# HELP log_archive_sources Number of configured sources.",
    "# TYPE log_archive_sources gauge",
    `log_archive_sources ${status.sourceCount}`,
    "# HELP log_archive_spool_bytes Bytes currently retained in the spool.",
    "# TYPE log_archive_spool_bytes gauge",
    `log_archive_spool_bytes ${status.spool.bytes}`,
    "# HELP log_archive_archive_pending Archive items not yet completed.",
    "# TYPE log_archive_archive_pending gauge",
    `log_archive_archive_pending ${status.spool.pending}`,
    "# HELP log_archive_archive_failed Archive items in failed state.",
    "# TYPE log_archive_archive_failed gauge",
    `log_archive_archive_failed ${status.spool.failed}`,
    "",
  ];
  response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  response.end(lines.join("\n"));
}

function applyHeaders(response, correlationId) {
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-correlation-id", correlationId);
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

class RateLimiter {
  #limit;
  #buckets = new Map();
  constructor(limit) { this.#limit = limit; }
  accept(key) {
    const minute = Math.floor(Date.now() / 60_000);
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.minute !== minute) {
      this.#buckets.set(key, { minute, count: 1 });
      if (this.#buckets.size > 10_000) this.#buckets.clear();
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.#limit;
  }
}

