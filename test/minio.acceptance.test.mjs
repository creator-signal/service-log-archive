import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { RotationEngine } from "../src/rotation.mjs";
import { StateStore } from "../src/state.mjs";

const enabled = Boolean(process.env.MINIO_ACCEPTANCE_ENDPOINT);

test("real S3-compatible endpoint accepts, verifies, retries, and restores an immutable segment", { skip: !enabled }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "log-archive-minio-"));
  const directories = Object.fromEntries(["logs", "state", "spool", "archive", "secrets"].map((name) => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })));
  const accessFile = path.join(directories.secrets, "access");
  const secretFile = path.join(directories.secrets, "secret");
  const tokenFile = path.join(directories.secrets, "tokens.json");
  await writeFile(accessFile, process.env.MINIO_ACCEPTANCE_ACCESS_KEY, { mode: 0o600 });
  await writeFile(secretFile, process.env.MINIO_ACCEPTANCE_SECRET_KEY, { mode: 0o600 });
  await writeFile(tokenFile, '{"tokens":[{"id":"unused","role":"administrator","sha256":"ed20191044553dac8f9c45e62062dd18e7dc1f898a897240b4179fb84fea3db4"}]}');
  const config = await loadConfig({
    LOG_ARCHIVE_DATA_DIR: directories.state,
    LOG_ARCHIVE_SPOOL_DIR: directories.spool,
    LOG_ARCHIVE_ARCHIVE_DIR: directories.archive,
    LOG_ARCHIVE_ALLOWED_ROOTS: directories.logs,
    LOG_ARCHIVE_TOKEN_FILE: tokenFile,
    LOG_ARCHIVE_S3_ENDPOINT: process.env.MINIO_ACCEPTANCE_ENDPOINT,
    LOG_ARCHIVE_S3_BUCKET: process.env.MINIO_ACCEPTANCE_BUCKET,
    LOG_ARCHIVE_S3_PREFIX: `acceptance/${Date.now()}`,
    LOG_ARCHIVE_S3_ACCESS_KEY_FILE: accessFile,
    LOG_ARCHIVE_S3_SECRET_KEY_FILE: secretFile,
  });
  const store = new StateStore(config);
  await store.load();
  const engine = new RotationEngine(config, store);
  const active = path.join(directories.logs, "minio.log");
  await writeFile(active, "minio-event-1\nminio-event-2\n");
  try {
    await engine.createSource({ id: "minio-log", path: active, maxBytes: 1, intervalSeconds: 0 }, "acceptance");
    await engine.rotate("minio-log", "acceptance");
    assert.equal(store.snapshot().segments.at(-1).destination, "s3");
    assert.equal((await engine.retryPending("acceptance")).length, 0);
    assert.equal((await engine.verifyRestore("acceptance")).result, "passed");
    assert.equal((await engine.status()).spool.pending, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

