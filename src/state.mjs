import { readFile } from "node:fs/promises";
import path from "node:path";
import {durableWrite} from './durable.mjs';

const emptyState = () => ({
  schemaVersion: 2,
  revision: 0,
  sources: [],
  segments: [],
  rotations: [],
  executions: [],
  audit: [],
  restoreVerifications: [],
});

export class StateStore {
  #file;
  #state = emptyState();
  #writeQueue = Promise.resolve();
  #historyLimit;
  #persistBytes;
  #blocked=false;

  constructor(config,{persist=durableWrite}={}) {
    this.#file = path.join(config.dataDir, "state.json");
    this.#historyLimit = config.historyLimit;
    this.#persistBytes=persist;
  }

  async load() {
    let bytes;
    try {
      bytes=await readFile(this.#file,'utf8');
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#persist(this.#state);
    }
    if(bytes!==undefined){
      const parsed=JSON.parse(bytes),next=migrate(parsed);
      if(parsed.schemaVersion!==next.schemaVersion)await this.#persist(next);
      this.#state=next;
    }
    this.#blocked=false;
    return this.snapshot();
  }

  snapshot() {
    if(this.#blocked)throw new Error('Durable state unavailable; reload is required');
    return structuredClone(this.#state);
  }

  async mutate(mutator) {
    let result;
    const operation = this.#writeQueue.catch(()=>{}).then(async () => {
      if(this.#blocked)throw new Error('Durable state unavailable; reload is required');
      const draft = structuredClone(this.#state);
      result = await mutator(draft);
      draft.revision += 1;
      draft.executions = draft.executions.slice(-this.#historyLimit);
      draft.audit = draft.audit.slice(-this.#historyLimit);
      draft.restoreVerifications = draft.restoreVerifications.slice(-this.#historyLimit);
      try{await this.#persist(draft);}
      catch(error){
        // Rename can have succeeded before a directory fsync failed. Reconcile
        // the actually published bytes rather than overwriting an unknown state.
        try{this.#state=migrate(JSON.parse(await readFile(this.#file,'utf8')));}
        catch{this.#blocked=true;}
        throw error;
      }
      this.#state = draft;
    });
    this.#writeQueue=operation;
    await operation;
    return result;
  }

  async #persist(state) {
    await this.#persistBytes(this.#file,`${JSON.stringify(state,null,2)}\n`);
  }
}

export function migrate(input) {
  if (!input || typeof input !== "object") throw new Error("State document must be an object");
  if (![1,2].includes(input.schemaVersion)) throw new Error(`Unsupported state schema version: ${input.schemaVersion}`);
  for(const field of ['sources','segments','rotations','executions','audit','restoreVerifications'])if(input[field]!==undefined&&!Array.isArray(input[field]))throw new Error('State collection is malformed');
  return {
    ...emptyState(),
    ...input,
    schemaVersion:2,
    sources: Array.isArray(input.sources) ? input.sources : [],
    segments: Array.isArray(input.segments) ? input.segments : [],
    rotations: Array.isArray(input.rotations) ? input.rotations : [],
    executions: Array.isArray(input.executions) ? input.executions : [],
    audit: Array.isArray(input.audit) ? input.audit : [],
    restoreVerifications: Array.isArray(input.restoreVerifications) ? input.restoreVerifications : [],
  };
}

