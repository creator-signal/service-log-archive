import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, test } from "node:test";
import { Authenticator, hashToken } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";
import { RotationEngine } from "../src/rotation.mjs";
import { createLogArchiveServer } from "../src/server.mjs";
import { migrate, StateStore } from "../src/state.mjs";

const temporaryDirectories = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "log-archive-test-"));
  temporaryDirectories.push(root);
  const directories = Object.fromEntries(["logs", "state", "spool", "archive", "secrets"].map((name) => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })));
  const adminToken = "test-administrator-token";
  const viewerToken = "test-viewer-token";
  const tokenFile = path.join(directories.secrets, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ tokens: [
    { id: "test-admin", role: "administrator", sha256: hashToken(adminToken) },
    { id: "test-viewer", role: "viewer", sha256: hashToken(viewerToken) },
  ] }));
  const config = await loadConfig({
    LOG_ARCHIVE_DATA_DIR: directories.state,
    LOG_ARCHIVE_SPOOL_DIR: directories.spool,
    LOG_ARCHIVE_ARCHIVE_DIR: directories.archive,
    LOG_ARCHIVE_ALLOWED_ROOTS: directories.logs,
    LOG_ARCHIVE_TOKEN_FILE: tokenFile,
    LOG_ARCHIVE_SCHEDULER_INTERVAL_SECONDS: "3600",
    LOG_ARCHIVE_SPOOL_MAX_BYTES: "1048576",
  });
  const store = new StateStore(config);
  await store.load();
  const auth = new Authenticator(config);
  await auth.load();
  const engine = new RotationEngine(config, store);
  return { root, directories, config, store, auth, engine, adminToken, viewerToken };
}

test("scoped token authentication never stores or returns the plaintext credential", async () => {
  const { auth, adminToken, viewerToken } = await fixture();
  assert.equal((await auth.authenticate(`Bearer ${adminToken}`)).role, "administrator");
  assert.equal((await auth.authenticate(`Bearer ${viewerToken}`)).role, "viewer");
  assert.equal(await auth.authenticate("Bearer incorrect"), null);
  assert.equal(hashToken(adminToken), createHash("sha256").update(adminToken).digest("hex"));
});

test("OIDC validates discovery-bound RS256 tokens, audience, expiry, and scoped role", async () => {
  const { directories } = await fixture();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  let issuer;
  const identity = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/openid-configuration") response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/keys` }));
    else if (request.url === "/keys") response.end(JSON.stringify({ keys: [jwk] }));
    else response.writeHead(404).end("{}");
  });
  await new Promise((resolve) => identity.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${identity.address().port}`;
  const config = await loadConfig({
    LOG_ARCHIVE_DATA_DIR: directories.state,
    LOG_ARCHIVE_SPOOL_DIR: directories.spool,
    LOG_ARCHIVE_ARCHIVE_DIR: directories.archive,
    LOG_ARCHIVE_ALLOWED_ROOTS: directories.logs,
    LOG_ARCHIVE_TOKEN_FILE: path.join(directories.secrets, "tokens.json"),
    LOG_ARCHIVE_OIDC_ISSUER: issuer,
    LOG_ARCHIVE_OIDC_AUDIENCE: "log-archive",
  });
  const auth = new Authenticator(config);
  await auth.load();
  const issueJwt = (claims) => {
    const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
    const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const content = `${encodedHeader}.${encodedClaims}`;
    return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
  };
  const baseClaims = { iss: issuer, aud: "log-archive", sub: "operator-1", exp: Math.floor(Date.now() / 1000) + 60, log_archive_role: "operator" };
  try {
    assert.deepEqual(await auth.authenticate(`Bearer ${issueJwt(baseClaims)}`), { subject: "oidc:operator-1", role: "operator", method: "oidc" });
    assert.equal(await auth.authenticate(`Bearer ${issueJwt({ ...baseClaims, aud: "wrong" })}`), null);
    assert.equal(await auth.authenticate(`Bearer ${issueJwt({ ...baseClaims, exp: 1 })}`), null);
  } finally {
    await new Promise((resolve) => identity.close(resolve));
  }
});

test("rename/create rotations preserve synthetic events exactly once and archive immutable gzip segments", async () => {
  const { directories, store, engine } = await fixture();
  const active = path.join(directories.logs, "audit.log");
  const first = Array.from({ length: 50 }, (_, index) => `event-${index}`).join("\n") + "\n";
  const second = Array.from({ length: 50 }, (_, index) => `event-${index + 50}`).join("\n") + "\n";
  await writeFile(active, first, { mode: 0o640 });
  await engine.createSource({ id: "audit-log", name: "Audit", path: active, strategy: "rename-create", maxBytes: 1, intervalSeconds: 0 }, "test:admin");
  const firstManifest = await engine.rotate("audit-log", "test:operator");
  await writeFile(active, second);
  const secondManifest = await engine.rotate("audit-log", "test:operator");

  const archivedDirectory = path.join(directories.archive, "audit-log");
  const compressed = (await readdir(archivedDirectory)).filter((name) => name.endsWith(".log.gz")).sort();
  assert.equal(compressed.length, 2);
  const contents = await Promise.all(compressed.map(async (name) => gunzipSync(await readFile(path.join(archivedDirectory, name), null)).toString("utf8")));
  assert.deepEqual(contents.sort(), [first, second].sort());
  assert.notEqual(firstManifest.segmentId, secondManifest.segmentId);
  assert.equal((await readFile(active, "utf8")), "");
  assert.equal(store.snapshot().segments.every((segment) => segment.status === "completed"), true);
  assert.equal((await engine.verifyRestore("test:operator")).result, "passed");
});

test("source registration rejects path escape, symlinks, duplicates, and unacknowledged copytruncate", async () => {
  const { root, directories, engine } = await fixture();
  const outside = path.join(root, "outside.log");
  const allowed = path.join(directories.logs, "allowed.log");
  const linked = path.join(directories.logs, "linked.log");
  await writeFile(outside, "secret\n");
  await writeFile(allowed, "event\n");
  await assert.rejects(() => engine.createSource({ id: "outside-log", path: outside, maxBytes: 1 }, "test"), /outside allowed roots/);
  try {
    await symlink(outside, linked, "file");
    await assert.rejects(() => engine.createSource({ id: "linked-log", path: linked, maxBytes: 1 }, "test"), /outside allowed roots|non-symlink/);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }
  await assert.rejects(() => engine.createSource({ id: "copy-log", path: allowed, maxBytes: 1, strategy: "copytruncate" }, "test"), /explicit acknowledgement/);
  await engine.createSource({ id: "allowed-log", path: allowed, maxBytes: 1 }, "test");
  await assert.rejects(() => engine.createSource({ id: "duplicate-log", path: allowed, maxBytes: 1 }, "test"), /unique/);
});

test("HTTP API enforces role capabilities, CSP, bounded probes, and content-free operational responses", async () => {
  const { config, store, auth, engine, adminToken, viewerToken, directories } = await fixture();
  const active = path.join(directories.logs, "http.log");
  await writeFile(active, "raw-secret-event\n");
  const server = createLogArchiveServer({ config, store, auth, engine, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const live = await fetch(`${base}/livez`);
    assert.equal(live.status, 200);
    assert.match(live.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.deepEqual(await live.json(), { status: "live" });
    assert.equal((await fetch(`${base}/api/v1/status`)).status, 401);
    const forbidden = await fetch(`${base}/api/v1/sources`, { method: "POST", headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(forbidden.status, 403);
    const created = await fetch(`${base}/api/v1/sources`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "http-log", name: "HTTP", path: active, maxBytes: 1024 }),
    });
    assert.equal(created.status, 201);
    const responseText = await (await fetch(`${base}/api/v1/sources`, { headers: { authorization: `Bearer ${viewerToken}` } })).text();
    assert.doesNotMatch(responseText, /raw-secret-event|test-administrator-token|test-viewer-token/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("state migration fails closed on unknown schemas", () => {
  assert.equal(migrate({ schemaVersion: 1, sources: [] }).schemaVersion, 1);
  assert.throws(() => migrate({ schemaVersion: 999 }), /Unsupported state schema/);
});
