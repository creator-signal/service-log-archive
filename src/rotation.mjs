import { createHash, randomUUID,randomInt } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  link,
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
import { S3Archive } from "./s3.mjs";
import {durableWrite,syncFile,syncDirectory} from "./durable.mjs";
import {pidProducer} from "./reopen.mjs";
import {byteLimit,verifyJsonl} from './restore.mjs';

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
  #s3;
  #signaler;
  #producer;
  #checkpoint;
  #archiveLocks=new Map();
  #restoring=false;
  #restoreReserved=0;
  #cacheQueue=Promise.resolve();

  constructor(config, store, { s3 = new S3Archive(config), signaler = process.kill, producer=pidProducer, checkpoint=async()=>{} } = {}) {
    this.#config = config;
    this.#store = store;
    this.#s3 = s3;
    this.#signaler = signaler;
    this.#producer=producer;this.#checkpoint=checkpoint;
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
      if(state.rotations.some(row=>row.source.id===id))throw conflict('Source has an unfinished rotation');
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
      if(state.rotations.some(row=>row.source.id===id))throw conflict('Source has an unfinished rotation');
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
    await this.retryPending('system:scheduler');
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
    if(this.#locks.has(sourceId))throw conflict("A rotation is already running for this source");
    this.#locks.add(sourceId);
    try {
      const source=this.#store.snapshot().sources.find(row=>row.id===sourceId);
      if(!source)throw notFound("Source not found");
      if(!source.enabled&&trigger!=="manual")return null;
      if(this.#store.snapshot().rotations.some(row=>row.source.id===sourceId))throw conflict('Source has an unfinished rotation; recover it before another rotation');
      await this.#assertPath(source.path);
      const before=await stat(source.path);
      if(!before.size)throw conflict('Active log file is empty');
      const producer=source.reopenSignal?await this.#producer.capture(source,before):null;
      const segmentId=randomUUID(),startedAt=new Date().toISOString();
      const intent={segmentId,source:structuredClone(source),actor,trigger,correlationId,startedAt,
        base:`${utcName(new Date(startedAt))}-${segmentId}`,phase:'reserved',before:fileIdentity(before),producer,
        reservedBytes:workingBytes(before.size)};
      const usage=await directoryBytes(this.#config.spoolDir);
      await this.#store.mutate(state=>{
        const reservations=state.rotations.reduce((sum,row)=>sum+row.reservedBytes,0);
        if(usage+reservations+this.#restoreReserved+intent.reservedBytes>this.#config.spoolMaxBytes)throw conflict('Spool capacity would be exceeded');
        state.rotations.push(intent);
      });
      await this.#checkpoint('reserved');
      const manifest=await this.#resumeRotation(intent);
      await this.archiveSegment(segmentId);
      return manifest;
    }catch(error){
      await this.#recordExecution(sourceId,trigger,'failed',error.message,undefined,correlationId).catch(()=>{});
      throw error;
    }finally{this.#locks.delete(sourceId);}
  }

  #paths(intent){
    const source=intent.source;
    if(!/^[a-z][a-z0-9-]{1,62}$/.test(source.id)||!/^[0-9TZ.]+-[a-f0-9-]{36}$/.test(intent.base)||!intent.base.endsWith(intent.segmentId))throw new Error('Rotation intent identity invalid');
    const directory=path.join(this.#config.spoolDir,source.id),rawPath=path.join(directory,`${intent.base}.log`);
    return {directory,rawPath,compressedPath:rawPath+'.gz',manifestPath:path.join(directory,`${intent.base}.manifest.json`),
      stagingPath:path.join(path.dirname(source.path),`.${path.basename(source.path)}.${intent.base}.rotating`),
      replacementPath:path.join(path.dirname(source.path),`.${path.basename(source.path)}.${intent.base}.replacement`)};
  }

  async #phase(intent,phase,fields={}){
    await this.#store.mutate(state=>{
      const row=state.rotations.find(row=>row.segmentId===intent.segmentId);
      if(!row)throw new Error('Rotation intent disappeared');
      Object.assign(row,fields,{phase});
    });
    Object.assign(intent,fields,{phase});
    await this.#checkpoint(phase);
  }

  async #resumeRotation(intent){
    const {source}=intent,files=this.#paths(intent);
    const parent=await realpath(path.dirname(source.path));
    if(!this.#config.allowedRoots.some(root=>within(root,parent)))throw new Error('Rotation parent escaped configured roots');
    const existing=this.#store.snapshot().segments.find(row=>row.segmentId===intent.segmentId);
    if(existing){await this.#cleanupRotation(intent,files);return existing;}
    await mkdir(files.directory,{recursive:true});
    if(source.strategy==='copytruncate'){
      // An interrupted truncate cannot be replayed safely: preserve the copied
      // data and deny until explicit reconciliation, rather than truncating new writes.
      if(intent.phase!=='reserved')throw new Error('Interrupted copytruncate requires reconciliation; retained files were preserved');
      await this.#assertPath(source.path);
      if(!sameFile(await stat(source.path),intent.before))throw new Error('Active inode changed before rotation');
      await copyFile(source.path,files.rawPath,constants.COPYFILE_EXCL);await syncFile(files.rawPath);
      await this.#phase(intent,'truncating');
      await truncate(source.path,0);await syncFile(source.path);
    }else{
      let staged=await optionalFile(files.stagingPath);
      if(!staged){
        const active=await optionalFile(source.path);
        if(!active||!sameFile(active,intent.before))throw new Error('Original rotation inode is unavailable; retained state was preserved');
        await rename(source.path,files.stagingPath);await syncDirectory(parent);
        staged=await optionalFile(files.stagingPath);
      }
      if(!sameFile(staged,intent.before))throw new Error('Retained original inode differs');
      if(intent.phase==='reserved')await this.#phase(intent,'renamed');
      if(!intent.replacement){
        let replacement=await optionalFile(files.replacementPath);
        if(!replacement){
          const handle=await open(files.replacementPath,'wx',intent.before.mode);
          try{await handle.sync();}finally{await handle.close();}
          await chmod(files.replacementPath,intent.before.mode);
          if(process.platform!=='win32')await chown(files.replacementPath,intent.before.uid,intent.before.gid);
          replacement=await optionalFile(files.replacementPath);
        }
        if(replacement.size!==0||(replacement.mode&0o777)!==intent.before.mode)throw new Error('Replacement file custody differs');
        await this.#phase(intent,'replacement-prepared',{replacement:fileIdentity(replacement)});
      }
      let active=await optionalFile(source.path);
      if(!active){await link(files.replacementPath,source.path);await syncDirectory(parent);active=await optionalFile(source.path);}
      if(!sameFile(active,intent.replacement))throw new Error('Foreign active inode appeared during rotation');
      const replacement=await optionalFile(files.replacementPath);
      if(replacement){if(!sameFile(replacement,intent.replacement))throw new Error('Foreign replacement inode');await rm(files.replacementPath);await syncDirectory(parent);}
      if(!['reopened','copied','compressed'].includes(intent.phase)){
        await this.#phase(intent,'replacement-created');
        await this.#notifyReopen(source,intent);
        await this.#phase(intent,'reopened');
      }
      if(source.reopenSignal)await this.#producer.verify(source,intent.before,intent.replacement,intent.producer);
      const stableBefore=await stat(files.stagingPath);
      // Before queued ownership is durable the retained producer inode remains
      // authoritative. Discard only this intent's derived partial copies on
      // replay, so an interrupted copy cannot double its working-space budget.
      for(const filename of [files.rawPath,files.rawPath+'.next',files.compressedPath,files.compressedPath+'.next',files.manifestPath])await removeOwnedPartial(filename);
      const usage=await directoryBytes(this.#config.spoolDir);
      const other=this.#store.snapshot().rotations.filter(row=>row.segmentId!==intent.segmentId).reduce((sum,row)=>sum+row.reservedBytes,0);
      if(usage+other+this.#restoreReserved+workingBytes(stableBefore.size)>this.#config.spoolMaxBytes)throw conflict('Spool capacity would be exceeded after producer handoff');
      const partial=files.rawPath+'.next';await removeOwnedPartial(partial);
      await copyFile(files.stagingPath,partial,constants.COPYFILE_EXCL);await syncFile(partial);
      const stableAfter=await stat(files.stagingPath);
      if(!sameFile(stableBefore,stableAfter)||stableBefore.size!==stableAfter.size||stableBefore.mtimeMs!==stableAfter.mtimeMs)throw new Error('Producer continued writing the retained inode; rotation was not completed');
      await rename(partial,files.rawPath);await syncDirectory(files.directory);
      await this.#phase(intent,'copied',{stable:fileIdentity(stableAfter),originalBytes:stableAfter.size});
    }
    const originalBytes=(await stat(files.rawPath)).size;
    const partial=files.compressedPath+'.next';await removeOwnedPartial(partial);
    await pipeline(createReadStream(files.rawPath),createGzip({level:source.compressionLevel}),createWriteStream(partial,{flags:'wx',mode:0o600}));
    await syncFile(partial);await rename(partial,files.compressedPath);await syncDirectory(files.directory);
    await this.#phase(intent,'compressed');
    const compressedBytes=(await stat(files.compressedPath)).size,checksum=await sha256File(files.compressedPath);
    const manifest={schemaVersion:1,segmentId:intent.segmentId,sourceId:source.id,sourcePath:source.path,rotatedAt:intent.startedAt,
      originalBytes,compressedBytes,compression:'gzip',sha256:checksum,format:source.format??'text'};
    await durableWrite(files.manifestPath,JSON.stringify(manifest,null,2)+'\n');
    await this.#store.mutate(state=>{
      state.segments.push({...manifest,compressedPath:files.compressedPath,manifestPath:files.manifestPath,status:'pending',attempts:0,lastError:null,archivedAt:null});
      state.rotations.find(row=>row.segmentId===intent.segmentId).phase='queued';
      state.executions.push({sourceId:source.id,trigger:intent.trigger,startedAt:intent.startedAt,completedAt:new Date().toISOString(),result:'completed',error:null,correlationId:intent.correlationId});
      state.audit.push(audit(intent.actor,'rotation.run',source.id,'completed',intent.correlationId));
    });
    await this.#checkpoint('queued');
    await this.#cleanupRotation(intent,files);
    return manifest;
  }

  async #cleanupRotation(intent,files){
    const staged=await optionalFile(files.stagingPath);
    if(staged){
      if(!sameFile(staged,intent.before)||!intent.stable||staged.size!==intent.stable.size||staged.mtimeMs!==intent.stable.mtimeMs)throw new Error('Retained inode changed after capture; cleanup denied');
      await rm(files.stagingPath);await syncDirectory(path.dirname(files.stagingPath));
    }
    await removeOwnedPartial(files.rawPath);await removeOwnedPartial(files.rawPath+'.next');
    await this.#store.mutate(state=>{state.rotations=state.rotations.filter(row=>row.segmentId!==intent.segmentId);});
    await this.#checkpoint('rotation-cleaned');
  }

  async recoverRotations(){
    const outcomes=[];
    for(const snapshot of this.#store.snapshot().rotations){
      const sourceId=snapshot.source.id;
      if(this.#locks.has(sourceId))continue;
      this.#locks.add(sourceId);
      try{await this.#resumeRotation(snapshot);outcomes.push({segmentId:snapshot.segmentId,result:'recovered'});}
      catch(error){outcomes.push({segmentId:snapshot.segmentId,result:'failed',error:error.message});}
      finally{this.#locks.delete(sourceId);}
    }
    return outcomes;
  }

  async archiveSegment(segmentId){
    if(this.#archiveLocks.has(segmentId))return this.#archiveLocks.get(segmentId);
    const operation=this.#cacheQueue.catch(()=>{}).then(()=>this.#archiveSegment(segmentId));
    this.#cacheQueue=operation;
    this.#archiveLocks.set(segmentId,operation);
    try{return await operation;}finally{this.#archiveLocks.delete(segmentId);}
  }

  async #archiveSegment(segmentId){
    const segment=this.#store.snapshot().segments.find(row=>row.segmentId===segmentId);
    if(!segment)return;
    const directory=path.join(this.#config.spoolDir,segment.sourceId);
    if(!/^[a-z][a-z0-9-]{1,62}$/.test(segment.sourceId)||segment.compressedPath!==path.join(directory,path.basename(segment.compressedPath))||segment.manifestPath!==path.join(directory,path.basename(segment.manifestPath)))throw new Error('Segment file custody differs');
    const destination=path.join(this.#config.archiveDir,segment.sourceId);
    const compressedDestination=path.join(destination,path.basename(segment.compressedPath));
    const manifestDestination=path.join(destination,path.basename(segment.manifestPath));
    if(segment.status==='completed'){await this.#cleanupArchive(segment,compressedDestination,manifestDestination);return;}
    try{
      await mkdir(destination,{recursive:true});
      const cached=await optionalFile(compressedDestination),cachedManifest=await optionalFile(manifestDestination);
      const cacheBytes=await directoryBytes(this.#config.archiveDir);
      if(cacheBytes+(cached?0:segment.compressedBytes)+(cachedManifest?0:65536)>this.#config.archiveMaxBytes)throw conflict('Archive cache capacity would be exceeded');
      // v1 could remove all local copies before committing upload completion.
      if(!await optionalFile(segment.compressedPath)&&!cached){
        if(!this.#s3.enabled)throw new Error('Archive bytes unavailable; reconciliation denied');
        const bytes=manifestBytes(segment);
        const compressed=await this.#s3.verify(this.#s3.key(segment.sourceId,segment.compressedPath),segment.sha256,segment.compressedBytes);
        const remoteManifest=await this.#s3.verify(this.#s3.key(segment.sourceId,segment.manifestPath),createHash('sha256').update(bytes).digest('hex'),bytes.length);
        await this.#completeArchive(segmentId,{compressed,manifest:remoteManifest});
        await this.#cleanupArchive(this.#store.snapshot().segments.find(row=>row.segmentId===segmentId),compressedDestination,manifestDestination);
        return;
      }
      await copyOrVerify(segment.compressedPath,compressedDestination,segment.sha256);
      const manifestChecksum=createHash('sha256').update(manifestBytes(segment)).digest('hex');
      if(!await optionalFile(segment.manifestPath)&&cachedManifest)await copyOrVerify(manifestDestination,segment.manifestPath,manifestChecksum);
      await copyOrVerify(segment.manifestPath,manifestDestination,manifestChecksum);
      let remote=null;
      if(this.#s3.enabled){
        const compressed=await this.#s3.upload(compressedDestination,segment.sourceId,segment.sha256,'application/gzip');
        await this.#checkpoint('compressed-uploaded');
        const manifest=await this.#s3.upload(manifestDestination,segment.sourceId,manifestChecksum,'application/json');
        remote={compressed,manifest};
        await this.#checkpoint('uploaded');
      }
      await this.#completeArchive(segmentId,remote);
      await this.#checkpoint('archive-committed');
    }catch(error){
      if(this.#store.snapshot().segments.find(row=>row.segmentId===segmentId)?.status!=='completed')await this.#store.mutate(state=>{
        const entry=state.segments.find(row=>row.segmentId===segmentId);Object.assign(entry,{status:'failed',attempts:entry.attempts+1,lastError:error.message,nextAttemptAt:new Date(Date.now()+Math.min(300000,1000*2**Math.min(entry.attempts,8))+randomInt(250)).toISOString()});
      }).catch(()=>{});
      throw error;
    }
    await this.#cleanupArchive(this.#store.snapshot().segments.find(row=>row.segmentId===segmentId),compressedDestination,manifestDestination);
  }

  async #completeArchive(segmentId,remote){
    await this.#store.mutate(state=>{
      const entry=state.segments.find(row=>row.segmentId===segmentId);
      Object.assign(entry,{status:'completed',attempts:entry.attempts+1,archivedAt:new Date().toISOString(),lastError:null,destination:this.#s3.enabled?'s3':'local',remote,cleanupPending:true});
    });
  }

  async #cleanupArchive(segment,compressedDestination,manifestDestination){
    if(!segment.cleanupPending)return;
    // Accepted remote objects / local archive survive every cleanup interruption.
    for(const filename of [segment.compressedPath,segment.manifestPath,...(segment.destination==='s3'?[compressedDestination,manifestDestination]:[])])await removeOwnedPartial(filename);
    await this.#checkpoint('archive-cleaned');
    await this.#store.mutate(state=>{state.segments.find(row=>row.segmentId===segment.segmentId).cleanupPending=false;});
  }

  async retryPending(actor, correlationId = randomUUID()) {
    await this.recoverRotations();
    const pending = this.#store.snapshot().segments.filter((segment) => segment.status === "pending" || segment.status === "failed" || segment.cleanupPending);
    const outcomes = [];
    for (const segment of pending) {
      if(actor==='system:scheduler'&&segment.nextAttemptAt&&Date.parse(segment.nextAttemptAt)>Date.now())continue;
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

  async verifyRestore(actor, correlationId = randomUUID(),segmentId) {
    if(this.#restoring)throw conflict('A restore verification is already running');
    this.#restoring=true;
    try{return await this.#verifyRestore(actor,correlationId,segmentId);}finally{this.#restoring=false;this.#restoreReserved=0;}
  }

  async #verifyRestore(actor,correlationId,segmentId){
    if(segmentId!==undefined&&!/^[a-f0-9-]{36}$/.test(segmentId))throw invalid('Invalid restore segment identifier');
    const completed = this.#store.snapshot().segments.filter((segment) => segment.status === "completed"&&(!segmentId||segment.segmentId===segmentId)).at(-1);
    if (!completed) throw notFound("No archived segment is available for verification");
    let archived = path.join(this.#config.archiveDir, completed.sourceId, path.basename(completed.compressedPath));
    const downloaded = path.join(this.#config.spoolDir, `.restore-${completed.segmentId}.gz`);
    const temporary = path.join(this.#config.spoolDir, `.restore-${completed.segmentId}.tmp`);
    try {
      if(!Number.isSafeInteger(completed.originalBytes)||!Number.isSafeInteger(completed.compressedBytes)||completed.originalBytes<0||completed.compressedBytes<0)throw conflict('Restore working space exceeds spool bound');
      this.#restoreReserved=completed.originalBytes+completed.compressedBytes;
      const usage=await directoryBytes(this.#config.spoolDir);
      const reservations=this.#store.snapshot().rotations.reduce((sum,row)=>sum+row.reservedBytes,0);
      if(!Number.isSafeInteger(completed.originalBytes)||!Number.isSafeInteger(completed.compressedBytes)||completed.originalBytes<0||completed.compressedBytes<0||usage+reservations+this.#restoreReserved>this.#config.spoolMaxBytes)throw conflict('Restore working space exceeds spool bound');
      await removeOwnedPartial(downloaded);await removeOwnedPartial(temporary);
      if (completed.destination === "s3") {
        archived = await this.#s3.download(completed.remote.compressed.key, downloaded, completed.sha256,completed.compressedBytes);
      }
      if ((await sha256File(archived)) !== completed.sha256) throw new Error("Archived segment checksum does not match manifest");
      await pipeline(createReadStream(archived), createGunzip(),byteLimit(completed.originalBytes), createWriteStream(temporary, { mode: 0o600,flags:'wx' }));
      const restoredBytes = (await stat(temporary)).size;
      if (restoredBytes !== completed.originalBytes) throw new Error("Restored byte count does not match manifest");
      const restoredRecords=completed.format==='jsonl'?await verifyJsonl(temporary):null;
      const result = { segmentId: completed.segmentId, verifiedAt: new Date().toISOString(), result: "passed", restoredBytes,restoredRecords, correlationId };
      await this.#store.mutate((state) => {
        state.restoreVerifications.push(result);
        state.audit.push(audit(actor, "restore.verify", completed.segmentId, "passed", correlationId));
      });
      return result;
    } catch(error){
      await this.#store.mutate(state=>{
        state.restoreVerifications.push({segmentId:completed.segmentId,verifiedAt:new Date().toISOString(),result:'failed',correlationId});
        state.audit.push(audit(actor,'restore.verify',completed.segmentId,'failed',correlationId));
      }).catch(()=>{});
      throw error;
    } finally {
      await Promise.all([rm(temporary, { force: true }), rm(downloaded, { force: true })]);
    }
  }

  async status() {
    const state = this.#store.snapshot();
    const spoolBytes = await directoryBytes(this.#config.spoolDir);
    const incomplete = state.segments.filter((segment) => segment.status !== "completed");
    const lastCompleted = state.segments.filter((segment) => segment.status === "completed").at(-1);
    const sources=await this.listSources();
    const lastRestore=state.restoreVerifications.filter(row=>row.result==='passed').at(-1);
    return {
      stateRevision: state.revision,
      sourceCount: state.sources.length,
      enabledSourceCount: state.sources.filter((source) => source.enabled).length,
      sources:sources.map(row=>({id:row.id,enabled:row.enabled,health:row.health,activeBytes:row.activeBytes,lastRotationAt:state.executions.filter(e=>e.sourceId===row.id&&e.result==='completed').at(-1)?.completedAt??null})),
      rotations:{pending:state.rotations.length,failures:state.executions.filter(row=>row.result==='failed').length},
      restoreAgeSeconds:lastRestore?Math.max(0,(Date.now()-Date.parse(lastRestore.verifiedAt))/1000):null,
      spool: {
        bytes: spoolBytes,
        maxBytes: this.#config.spoolMaxBytes,
        utilization: this.#config.spoolMaxBytes ? spoolBytes / this.#config.spoolMaxBytes : 0,
        pending: incomplete.length,
        failed: incomplete.filter((segment) => segment.status === "failed").length,
        oldestAt: incomplete.map((segment) => segment.rotatedAt).sort()[0] || null,
      },
      lastRestoreVerification: state.restoreVerifications.at(-1) || null,
      archiveDestination: this.#s3.enabled ? "s3" : "local",
      destinationHealth: {
        status: incomplete.some((segment) => segment.status === "failed") ? "degraded" : lastCompleted ? "healthy" : "unknown",
        lastSuccessAt: lastCompleted?.archivedAt || null,
      },
    };
  }

  async #sourceView(source, state) {
    let file = null;
    let health = source.enabled ? "unknown" : "disabled";
    try {
      file = await stat(source.path);
      health = source.enabled ? "healthy" : "disabled";
    } catch (error) {
      if (error.code !== "ENOENT") health = "critical";
    }
    const executions = state.executions.filter((entry) => entry.sourceId === source.id).slice(-20).reverse();
    const pending = state.segments.filter((segment) => segment.sourceId === source.id && segment.status !== "completed");
    if (pending.some((segment) => segment.status === "failed")) health = "critical";
    else if (pending.length > 0) health = "warning";
    if(state.rotations.some(row=>row.source.id===source.id))health='critical';
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
    const reopenSignal = input.reopenSignal ? String(input.reopenSignal).toUpperCase() : null;
    const reopenPid = input.reopenPid === undefined || input.reopenPid === null || input.reopenPid === "" ? null : boundedInteger(input.reopenPid, null, 1, 4_194_304);
    if (reopenSignal && !["SIGHUP", "SIGUSR1", "SIGUSR2"].includes(reopenSignal)) throw invalid("Reopen signal must be SIGHUP, SIGUSR1, or SIGUSR2");
    if (Boolean(reopenSignal) !== Boolean(reopenPid)) throw invalid("Reopen signal and PID must be configured together");
    if (reopenUrl && reopenSignal) throw invalid("Configure one reopen callback or signal adapter, not both");
    if(!["text","jsonl"].includes(input.format??"text"))throw invalid("Unsupported source format");
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
      format: input.format===undefined?"text":String(input.format),
      reopenTimeoutMs:boundedInteger(input.reopenTimeoutMs,5000,25,60000),
      reopenUrl,
      reopenSignal,
      reopenPid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async #assertPath(candidate) {
    const canonical = await realpath(candidate);
    if (!this.#config.allowedRoots.some((root) => within(root, canonical))) throw invalid("Source path is outside allowed roots");
    const information = await lstat(candidate);
    if (!information.isFile() || information.isSymbolicLink() || information.nlink!==1) throw invalid("Source path must be a regular non-symlink file with one link");
    return canonical;
  }

  async #notifyReopen(source,intent){
    if(source.reopenSignal){
      this.#signaler(source.reopenPid,source.reopenSignal);
      await this.#producer.verify(source,intent.before,intent.replacement,intent.producer);
    }else if(source.reopenUrl){
      const response=await fetch(source.reopenUrl,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({sourceId:source.id,path:source.path,segmentId:intent.segmentId}),signal:AbortSignal.timeout(source.reopenTimeoutMs??5000)});
      if(!response.ok)throw new Error('Reopen callback rejected request');
      let bytes=0,text='';for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2048)throw new Error('Reopen acknowledgement exceeds bound');text+=Buffer.from(chunk).toString('utf8');}
      const ack=JSON.parse(text);
      if(ack.reopened!==true||ack.segmentId!==intent.segmentId)throw new Error('Reopen callback did not acknowledge this rotation');
    }
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

function manifestBytes(segment){
  const manifest={};
  for(const key of ['schemaVersion','segmentId','sourceId','sourcePath','rotatedAt','originalBytes','compressedBytes','compression','sha256','format'])if(segment[key]!==undefined)manifest[key]=segment[key];
  return Buffer.from(JSON.stringify(manifest,null,2)+'\n');
}

async function copyOrVerify(source,destination,checksum){
  const present=await optionalFile(destination);
  if(!present){
    const origin=await optionalFile(source);
    if(!origin||origin.nlink!==1)throw new Error('Archive source custody differs');
    if(await sha256File(source)!==checksum)throw new Error('Archive source checksum differs from ledger');
    try{await copyFile(source,destination,constants.COPYFILE_EXCL);}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  const copied=await optionalFile(destination);
  if(!copied||copied.nlink!==1)throw new Error('Archive destination custody differs');
  if(await sha256File(destination)!==checksum)throw new Error('Immutable archive destination already exists with different content');
  await syncFile(destination);await syncDirectory(path.dirname(destination));
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

const fileIdentity=value=>({dev:String(value.dev),ino:String(value.ino),size:value.size,mtimeMs:value.mtimeMs,mode:value.mode&0o777,uid:value.uid,gid:value.gid});
const sameFile=(a,b)=>a&&b&&String(a.dev)===String(b.dev)&&String(a.ino)===String(b.ino);
export const workingBytes=size=>{
  const required=size*2+Math.ceil(size/4096)+Math.ceil(size/16384)+Math.ceil(size/33554432)+65536;
  if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(required))throw new Error('Invalid rotation working-space bound');
  return required;
};
async function optionalFile(filename){
  try{const value=await lstat(filename);if(!value.isFile()||value.isSymbolicLink())throw new Error('Rotation artifact is not a regular file');return value;}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function removeOwnedPartial(filename){if(await optionalFile(filename))await rm(filename);}
