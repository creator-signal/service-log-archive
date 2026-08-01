import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const utcName = (date = new Date()) => date.toISOString().replaceAll(":", "").replaceAll("-", "").replace(".000", "");
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const sha256File = async (file) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
};

export class RotationEngine {
  #config;
  #store;
  #locks = new Set();
  #timer;

  constructor(config, store) {
    this.#config = config;
    this.#store = store;
  }

  async start() {
    await this.retryPending("system:startup");
    this.#timer = setInterval(() => this.tick().catch((error) => this.#recordSystemFailure(error)), this.#config.schedulerIntervalMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  async listSources() {
    const state = this.#store.snapshot();
    return Promise.all(state.sources.map((source) => this.#sourceView(source, state)));
  }

  async createSource(input, actor, correlationId = randomUUID()) {
    const source = await this.#validatedSource(input);
    await this.#store.mutate((state) => {
      if (state.sources.some((candidate) => candidate.id === source.id || candidate.path === source.path)) {
        throw conflict("Source id and path must be unique");
      }
      state.sources.push(source);
      state.audit.push(audit(actor, "source.create", source.id, "accepted", correlationId));
    });
    return source;
  }

  async updateSource(id, input, actor, correlationId = randomUUID()) {
    const source = await this.#validatedSource({ ...input, id });
    await this.#store.mutate((state) => {
      const index = state.sources.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw notFound("Source not found");
      if (state.sources.some((candidate) => candidate.id !== id && candidate.path === source.path)) {
        throw conflict("Source path must be unique");
      }
      state.sources[index] = { ...source, createdAt: state.sources[index].createdAt };
      state.audit.push(audit(actor, "source.update", id, "accepted", correlationId));
    });
    return source;
  }

  async deleteSource(id, actor, correlationId = randomUUID()) {
    await this.#store.mutate((state) => {
      const source = state.sources.find((candidate) => candidate.id === id);
      if (!source) throw notFound("Source not found");
      if (state.segments.some((segment) => segment.sourceId === id && segment.status !== "completed")) {
        throw conflict("Source has incomplete archive work");
      }
      state.sources = state.sources.filter((candidate) => candidate.id !== id);
      state.audit.push(audit(actor, "source.delete", id, "accepted", correlationId));
    });
  }

  async tick(now = Date.now()) {
    const state = this.#store.snapshot();
    for (const source of state.sources.filter((candidate) => candidate.enabled)) {
      try {
        const file = await stat(source.path);
        const last = state.executions.filter((entry) => entry.sourceId === source.id && entry.result === "completed").at(-1);
        const dueBySize = source.maxBytes > 0 && file.size >= source.maxBytes;
        const dueByTime = source.intervalSeconds > 0 && (!last || now - Date.parse(last.completedAt) >= source.intervalSeconds * 1000);
        if (file.size > 0 && (dueBySize || dueByTime)) await this.rotate(source.id, "system:scheduler", dueBySize ? "size" : "time");
      } catch (error) {
        if (error.code !== "ENOENT") await this.#recordExecution(source.id, "scheduled", "failed", error.message);
      }
    }
  }

  async rotate(sourceId, actor, trigger = "manual", correlationId = randomUUID()) {
    if (this.#locks.has(sourceId)) throw conflict("A rotation is already running for this source");
    this.#locks.add(sourceId);
    const startedAt = new Date().toISOString();
    try {
      const source = this.#store.snapshot().sources.find((candidate) => candidate.id === sourceId);
      if (!source) throw notFound("Source not found");
      if (!source.enabled && trigger !== "manual") return null;
      await this.#assertPath(source.path);
      const before = await stat(source.path);
      if (before.size === 0) throw conflict("Active log file is empty");
      const spoolUsage = await directoryBytes(this.#config.spoolDir);
      if (spoolUsage + before.size > this.#config.spoolMaxBytes) throw conflict("Spool capacity would be exceeded");

      const segmentId = randomUUID();
      const directory = path.join(this.#config.spoolDir, source.id);
      await mkdir(directory, { recursive: true });
      const base = `${utcName()}-${segmentId}`;
      const rawPath = path.join(directory, `${base}.log`);
      const compressedPath = `${rawPath}.gz`;
      const manifestPath = path.join(directory, `${base}.manifest.json`);
      const stagingPath = path.join(path.dirname(source.path), `.${path.basename(source.path)}.${base}.rotating`);
      let reopenWarning = null;

      if (source.strategy === "rename-create") {
        await rename(source.path, stagingPath);
        try {
          const replacement = await open(source.path, "wx", before.mode & 0o777);
          await replacement.close();
        } catch (error) {
          await rename(stagingPath, source.path).catch(() => {});
          throw error;
        }
        await chmod(source.path, before.mode & 0o777);
        if (process.platform !== "win32") await chown(source.path, before.uid, before.gid);
        try {
          await this.#notifyReopen(source);
        } catch (error) {
          reopenWarning = error.message;
        }
        const stableBefore = await stat(stagingPath);
        await copyFile(stagingPath, rawPath, constants.COPYFILE_EXCL);
        const stableAfter = await stat(stagingPath);
        if (stableBefore.size !== stableAfter.size || stableBefore.mtimeMs !== stableAfter.mtimeMs) {
          await rm(rawPath, { force: true });
          throw new Error(`Producer continued writing the rotated inode; preserved ${path.basename(stagingPath)} for quarantine`);
        }
      } else {
        await copyFile(source.path, rawPath);
        await truncate(source.path, 0);
      }

      await pipeline(createReadStream(rawPath), createGzip({ level: source.compressionLevel }), createWriteStream(compressedPath, { mode: 0o600 }));
      await rm(rawPath);
      const compressedBytes = (await stat(compressedPath)).size;
      const checksum = await sha256File(compressedPath);
      const manifest = {
        schemaVersion: 1,
        segmentId,
        sourceId: source.id,
        sourcePath: source.path,
        rotatedAt: new Date().toISOString(),
        originalBytes: before.size,
        compressedBytes,
        compression: "gzip",
        sha256: checksum,
      };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });

      await this.#store.mutate((state) => {
        state.segments.push({
          ...manifest,
          compressedPath,
          manifestPath,
          status: "pending",
          attempts: 0,
          lastError: null,
          archivedAt: null,
        });
        state.executions.push({ sourceId, trigger, startedAt, completedAt: new Date().toISOString(), result: "completed", error: reopenWarning, correlationId });
        state.audit.push(audit(actor, "rotation.run", sourceId, reopenWarning ? "completed_with_warning" : "completed", correlationId));
      });
      if (source.strategy === "rename-create") await rm(stagingPath);
      await this.archiveSegment(segmentId);
      return { ...manifest, warning: reopenWarning };
    } catch (error) {
      await this.#recordExecution(sourceId, trigger, "failed", error.message, startedAt, correlationId);
      await this.#store.mutate((state) => state.audit.push(audit(actor, "rotation.run", sourceId, "failed", correlationId)));
      throw error;
    } finally {
      this.#locks.delete(sourceId);
    }
  }

  async archiveSegment(segmentId) {
    const segment = this.#store.snapshot().segments.find((candidate) => candidate.segmentId === segmentId);
    if (!segment || segment.status === "completed") return;
    const destination = path.join(this.#config.archiveDir, segment.sourceId);
    await mkdir(destination, { recursive: true });
    const compressedDestination = path.join(destination, path.basename(segment.compressedPath));
    const manifestDestination = path.join(destination, path.basename(segment.manifestPath));
    try {
      await copyOrVerify(segment.compressedPath, compressedDestination, segment.sha256);
      await copyOrVerify(segment.manifestPath, manifestDestination, await sha256File(segment.manifestPath));
      if ((await sha256File(compressedDestination)) !== segment.sha256) throw new Error("Archive checksum verification failed");
      await Promise.all([rm(segment.compressedPath, { force: true }), rm(segment.manifestPath, { force: true })]);
      await this.#store.mutate((state) => {
        const entry = state.segments.find((candidate) => candidate.segmentId === segmentId);
        Object.assign(entry, { status: "completed", attempts: entry.attempts + 1, archivedAt: new Date().toISOString(), lastError: null });
      });
    } catch (error) {
      await this.#store.mutate((state) => {
        const entry = state.segments.find((candidate) => candidate.segmentId === segmentId);
        Object.assign(entry, { status: "failed", attempts: entry.attempts + 1, lastError: error.message });
      });
      throw error;
    }
  }

  async retryPending(actor, correlationId = randomUUID()) {
    const pending = this.#store.snapshot().segments.filter((segment) => segment.status === "pending" || segment.status === "failed");
    const outcomes = [];
    for (const segment of pending) {
      try {
        await this.archiveSegment(segment.segmentId);
        outcomes.push({ segmentId: segment.segmentId, result: "completed" });
      } catch (error) {
        outcomes.push({ segmentId: segment.segmentId, result: "failed", error: error.message });
      }
    }
    if (pending.length > 0) {
      await this.#store.mutate((state) => state.audit.push(audit(actor, "archive.retry", "pending", "completed", correlationId)));
    }
    return outcomes;
  }

  async verifyRestore(actor, correlationId = randomUUID()) {
    const completed = this.#store.snapshot().segments.filter((segment) => segment.status === "completed").at(-1);
    if (!completed) throw notFound("No archived segment is available for verification");
    const archived = path.join(this.#config.archiveDir, completed.sourceId, path.basename(completed.compressedPath));
    const temporary = path.join(this.#config.spoolDir, `.restore-${completed.segmentId}.tmp`);
    try {
      if ((await sha256File(archived)) !== completed.sha256) throw new Error("Archived segment checksum does not match manifest");
      await pipeline(createReadStream(archived), createGunzip(), createWriteStream(temporary, { mode: 0o600 }));
      const restoredBytes = (await stat(temporary)).size;
      if (restoredBytes !== completed.originalBytes) throw new Error("Restored byte count does not match manifest");
      const result = { segmentId: completed.segmentId, verifiedAt: new Date().toISOString(), result: "passed", restoredBytes, correlationId };
      await this.#store.mutate((state) => {
        state.restoreVerifications.push(result);
        state.audit.push(audit(actor, "restore.verify", completed.segmentId, "passed", correlationId));
      });
      return result;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async status() {
    const state = this.#store.snapshot();
    const spoolBytes = await directoryBytes(this.#config.spoolDir);
    const incomplete = state.segments.filter((segment) => segment.status !== "completed");
    return {
      stateRevision: state.revision,
      sourceCount: state.sources.length,
      enabledSourceCount: state.sources.filter((source) => source.enabled).length,
      spool: {
        bytes: spoolBytes,
        maxBytes: this.#config.spoolMaxBytes,
        utilization: this.#config.spoolMaxBytes ? spoolBytes / this.#config.spoolMaxBytes : 0,
        pending: incomplete.length,
        failed: incomplete.filter((segment) => segment.status === "failed").length,
        oldestAt: incomplete.map((segment) => segment.rotatedAt).sort()[0] || null,
      },
      lastRestoreVerification: state.restoreVerifications.at(-1) || null,
    };
  }

  async #sourceView(source, state) {
    let file = null;
    let health = source.enabled ? "unknown" : "disabled";
    try {
      file = await stat(source.path);
      health = "healthy";
    } catch (error) {
      if (error.code !== "ENOENT") health = "critical";
    }
    const executions = state.executions.filter((entry) => entry.sourceId === source.id).slice(-20).reverse();
    const pending = state.segments.filter((segment) => segment.sourceId === source.id && segment.status !== "completed");
    if (pending.some((segment) => segment.status === "failed")) health = "critical";
    else if (pending.length > 0) health = "warning";
    return { ...source, activeBytes: file?.size ?? null, health, executions, pendingSegments: pending.length };
  }

  async #validatedSource(input) {
    const id = String(input.id || "").trim();
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) throw invalid("Source id must use lowercase letters, numbers, and hyphens");
    const candidatePath = path.resolve(String(input.path || ""));
    await this.#assertPath(candidatePath);
    const strategy = input.strategy || "rename-create";
    if (!["rename-create", "copytruncate"].includes(strategy)) throw invalid("Unsupported rotation strategy");
    if (strategy === "copytruncate" && input.copytruncateWarningAccepted !== true) {
      throw invalid("copytruncate requires explicit acknowledgement of its data-loss and duplication risk");
    }
    const maxBytes = boundedInteger(input.maxBytes, 0, 0, Number.MAX_SAFE_INTEGER);
    const intervalSeconds = boundedInteger(input.intervalSeconds, 86400, 0, 365 * 86400);
    if (maxBytes === 0 && intervalSeconds === 0) throw invalid("At least one size or time trigger is required");
    const reopenUrl = input.reopenUrl ? new URL(input.reopenUrl).toString() : null;
    if (reopenUrl && !reopenUrl.startsWith("http://127.0.0.1:") && !reopenUrl.startsWith("http://localhost:")) {
      throw invalid("Reopen callback must use loopback HTTP");
    }
    return {
      id,
      name: String(input.name || id).trim().slice(0, 100),
      path: candidatePath,
      enabled: input.enabled !== false,
      strategy,
      copytruncateWarningAccepted: strategy === "copytruncate" ? input.copytruncateWarningAccepted === true : false,
      maxBytes,
      intervalSeconds,
      compressionLevel: boundedInteger(input.compressionLevel, 6, 1, 9),
      reopenUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async #assertPath(candidate) {
    const canonical = await realpath(candidate);
    if (!this.#config.allowedRoots.some((root) => within(root, canonical))) throw invalid("Source path is outside allowed roots");
    const information = await lstat(candidate);
    if (!information.isFile() || information.isSymbolicLink()) throw invalid("Source path must be a regular non-symlink file");
    return canonical;
  }

  async #notifyReopen(source) {
    if (!source.reopenUrl) return;
    const response = await fetch(source.reopenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: source.id, path: source.path }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Reopen callback rejected request with ${response.status}`);
  }

  async #recordExecution(sourceId, trigger, result, error, startedAt = new Date().toISOString(), correlationId = randomUUID()) {
    await this.#store.mutate((state) => state.executions.push({ sourceId, trigger, startedAt, completedAt: new Date().toISOString(), result, error, correlationId }));
  }

  async #recordSystemFailure(error) {
    await this.#recordExecution("system", "scheduler", "failed", error.message);
  }
}

const audit = (actor, action, target, result, correlationId) => ({ actor, action, target, result, at: new Date().toISOString(), correlationId });
const problem = (status, message) => Object.assign(new Error(message), { status });
const invalid = (message) => problem(400, message);
const notFound = (message) => problem(404, message);
const conflict = (message) => problem(409, message);

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalid(`Value must be between ${minimum} and ${maximum}`);
  return parsed;
};

async function copyOrVerify(source, destination, checksum) {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await sha256File(destination)) !== checksum) throw new Error("Immutable archive destination already exists with different content");
  }
}

async function directoryBytes(directory) {
  let total = 0;
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(target) : (await stat(target)).size;
  }
  return total;
}
