import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const emptyState = () => ({
  schemaVersion: 1,
  revision: 0,
  sources: [],
  segments: [],
  executions: [],
  audit: [],
  restoreVerifications: [],
});

export class StateStore {
  #file;
  #state = emptyState();
  #writeQueue = Promise.resolve();
  #historyLimit;

  constructor(config) {
    this.#file = path.join(config.dataDir, "state.json");
    this.#historyLimit = config.historyLimit;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      this.#state = migrate(parsed);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#persist();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  async mutate(mutator) {
    let result;
    this.#writeQueue = this.#writeQueue.then(async () => {
      const draft = structuredClone(this.#state);
      result = await mutator(draft);
      draft.revision += 1;
      draft.executions = draft.executions.slice(-this.#historyLimit);
      draft.audit = draft.audit.slice(-this.#historyLimit);
      draft.restoreVerifications = draft.restoreVerifications.slice(-this.#historyLimit);
      this.#state = draft;
      await this.#persist();
    });
    await this.#writeQueue;
    return result;
  }

  async #persist() {
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}

export function migrate(input) {
  if (!input || typeof input !== "object") throw new Error("State document must be an object");
  if (input.schemaVersion !== 1) throw new Error(`Unsupported state schema version: ${input.schemaVersion}`);
  return {
    ...emptyState(),
    ...input,
    sources: Array.isArray(input.sources) ? input.sources : [],
    segments: Array.isArray(input.segments) ? input.segments : [],
    executions: Array.isArray(input.executions) ? input.executions : [],
    audit: Array.isArray(input.audit) ? input.audit : [],
    restoreVerifications: Array.isArray(input.restoreVerifications) ? input.restoreVerifications : [],
  };
}

