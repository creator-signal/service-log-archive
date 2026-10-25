import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {loadConfig} from '../src/config.mjs';
import {StateStore} from '../src/state.mjs';
import {RotationEngine,workingBytes} from '../src/rotation.mjs';
import {durableWrite} from '../src/durable.mjs';

async function fixture(t,limit=1048576){
 const root=await mkdtemp(path.join(os.tmpdir(),'archive-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dirs=Object.fromEntries(['logs','state','spool','archive'].map(n=>[n,path.join(root,n)]));
 await Promise.all(Object.values(dirs).map(p=>mkdir(p)));
 const config=await loadConfig({LOG_ARCHIVE_DATA_DIR:dirs.state,LOG_ARCHIVE_SPOOL_DIR:dirs.spool,LOG_ARCHIVE_ARCHIVE_DIR:dirs.archive,LOG_ARCHIVE_ALLOWED_ROOTS:dirs.logs,LOG_ARCHIVE_SPOOL_MAX_BYTES:String(limit),LOG_ARCHIVE_SCHEDULER_INTERVAL_SECONDS:'1'});
 const store=new StateStore(config);await store.load();
 const active=path.join(dirs.logs,'events.jsonl');await writeFile(active,'{"n":0}\n{"n":1}\n');
 return {dirs,config,store,active,source:{id:'synthetic',path:active,strategy:'rename-create',maxBytes:1,intervalSeconds:0,enabled:true,format:'jsonl'}};
}
function memoryArchive(){
 const objects=new Map();return {enabled:true,objects,upload:async(filename,source,checksum)=>{
  const key=path.basename(filename),bytes=await readFile(filename);assert.equal(createHash('sha256').update(bytes).digest('hex'),checksum);
  if(objects.has(key))assert.deepEqual(objects.get(key),bytes);else objects.set(key,bytes);
  return {key};
 },key:(_source,file)=>path.basename(file),verify:async(key,checksum,size)=>{
   const bytes=objects.get(key);assert.ok(bytes);assert.equal(bytes.length,size);assert.equal(createHash('sha256').update(bytes).digest('hex'),checksum);return {key};
 },download:async(key,destination,checksum)=>{const bytes=objects.get(key);assert.ok(bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),checksum);await writeFile(destination,bytes,{flag:'wx'});return destination;}};
}

test('a rejected mutation or failed durable write does not poison later valid state writes',async t=>{
 const f=await fixture(t);const engine=new RotationEngine(f.config,f.store);
 await engine.createSource(f.source,'test');await assert.rejects(engine.createSource(f.source,'test'),/unique/);
 const other=path.join(f.dirs.logs,'other.jsonl');await writeFile(other,'{}\n');
 await engine.createSource({...f.source,id:'other',path:other},'test');assert.equal(f.store.snapshot().sources.length,2);
 let failing=false;const store=new StateStore(f.config,{persist:async(file,bytes)=>{if(failing)throw new Error('synthetic disk unavailable');await durableWrite(file,bytes);}});await store.load();
 const before=store.snapshot();failing=true;await assert.rejects(store.mutate(s=>s.audit.push({action:'not-durable'})),/disk unavailable/);
 assert.deepEqual(store.snapshot(),before);failing=false;await store.mutate(s=>s.audit.push({action:'durable'}));assert.equal(store.snapshot().audit.at(-1).action,'durable');
});

test('failed or delayed reopen retains the original inode and recovers its later writes exactly once',async t=>{
 const f=await fixture(t);let acknowledged=false;
 const engine=new RotationEngine(f.config,f.store,{s3:{enabled:false},producer:{capture:async()=>({start:'synthetic'}),verify:async()=>{if(!acknowledged)throw new Error('synthetic reopen timeout');}},signaler:()=>{}});
 await engine.createSource({...f.source,reopenPid:42,reopenSignal:'SIGHUP'},'test');
 const writer=await open(f.active,'a');t.after(()=>writer.close());
 await assert.rejects(engine.rotate('synthetic','test'),/reopen timeout/);
 await writer.write('{"n":2}\n');assert.equal((await writer.stat()).nlink,1);assert.equal(f.store.snapshot().segments.length,0);
 assert.ok((await readdir(f.dirs.logs)).some(name=>name.endsWith('.rotating')));
 acknowledged=true;await engine.retryPending('test');
 const files=await readdir(path.join(f.dirs.archive,'synthetic'));const gz=files.find(n=>n.endsWith('.gz'));
 assert.equal(gunzipSync(await readFile(path.join(f.dirs.archive,'synthetic',gz))).toString(),'{"n":0}\n{"n":1}\n{"n":2}\n');
 assert.equal(f.store.snapshot().segments.length,1);assert.equal(f.store.snapshot().rotations.length,0);
});

for(const phase of ['reserved','renamed','replacement-prepared','replacement-created','reopened','copied','compressed','queued','rotation-cleaned','compressed-uploaded','uploaded','archive-committed','archive-cleaned']){
 test(`restart after ${phase} preserves one immutable segment and completes cleanup`,async t=>{
  const f=await fixture(t),s3=memoryArchive();let interrupted=false;
  const engine=new RotationEngine(f.config,f.store,{s3,checkpoint:async value=>{if(value===phase&&!interrupted){interrupted=true;throw new Error('synthetic interruption');}}});
  await engine.createSource(f.source,'test');await assert.rejects(engine.rotate('synthetic','test'),/synthetic interruption/);assert.equal(interrupted,true);
  const store=new StateStore(f.config);await store.load();const recovered=new RotationEngine(f.config,store,{s3});
  const outcomes=await recovered.retryPending('test');assert.ok(outcomes.every(r=>r.result==='completed'));
  assert.equal(store.snapshot().segments.length,1);assert.equal(store.snapshot().segments[0].status,'completed');assert.equal(store.snapshot().segments[0].cleanupPending,false);
  assert.equal(store.snapshot().rotations.length,0);assert.equal(s3.objects.size,2);assert.equal((await recovered.status()).spool.bytes,0);
  assert.equal((await recovered.verifyRestore('test')).result,'passed');
  assert.deepEqual(await recovered.retryPending('test'),[]);
 });
}

test('finite working-space admission refuses an oversized first segment before any rename',async t=>{
 const f=await fixture(t,65536);const engine=new RotationEngine(f.config,f.store);await engine.createSource(f.source,'test');
 const before=await readFile(f.active);assert.ok(workingBytes(before.length)>f.config.spoolMaxBytes);
 await assert.rejects(engine.rotate('synthetic','test'),/Spool capacity/);assert.deepEqual(await readFile(f.active),before);assert.equal(f.store.snapshot().rotations.length,0);
});

test('native delayed signal reopen preserves continuous numbered events across natural time and size triggers',{skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t);await writeFile(f.active,'');
 const code=String.raw`const fs=require('node:fs');let fd=fs.openSync(process.argv[1],'a'),n=0;const timer=setInterval(()=>fs.writeSync(fd,JSON.stringify({n:n++})+'\n'),5);process.on('SIGHUP',()=>setTimeout(()=>{fs.closeSync(fd);fd=fs.openSync(process.argv[1],'a');},60));process.on('message',m=>{if(m==='stop'){clearInterval(timer);fs.closeSync(fd);process.send({count:n});setTimeout(()=>process.exit(0),10);}});process.send({ready:true});`;
 const child=spawn(process.execPath,['-e',code,f.active],{stdio:['ignore','ignore','inherit','ipc']});t.after(()=>{if(child.exitCode===null)child.kill();});await once(child,'message');
 const engine=new RotationEngine(f.config,f.store);t.after(()=>engine.stop());
 await engine.createSource({...f.source,maxBytes:10000000,intervalSeconds:1,reopenPid:child.pid,reopenSignal:'SIGHUP',reopenTimeoutMs:2000},'test');await engine.start();
 const wait=async predicate=>{const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)assert.fail('native producer rotation timed out');await new Promise(r=>setTimeout(r,30));}};
 await wait(()=>f.store.snapshot().segments.length>=1);await engine.updateSource('synthetic',{...f.source,maxBytes:128,intervalSeconds:0,reopenPid:child.pid,reopenSignal:'SIGHUP',reopenTimeoutMs:2000},'test');
 await wait(()=>f.store.snapshot().segments.length>=2);engine.stop();const countPromise=once(child,'message');child.send('stop');const [{count}]=await countPromise;await once(child,'exit');
 const events=[];for(const segment of f.store.snapshot().segments)events.push(...gunzipSync(await readFile(path.join(f.dirs.archive,'synthetic',path.basename(segment.compressedPath)))).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s).n));
 events.push(...(await readFile(f.active,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s).n));
 assert.deepEqual(events.sort((a,b)=>a-b),Array.from({length:count},(_,n)=>n));
 assert.ok(f.store.snapshot().executions.some(e=>e.result==='completed'&&e.trigger==='time'));assert.ok(f.store.snapshot().executions.some(e=>e.result==='completed'&&e.trigger==='size'));
});


test('v1 upload-before-ledger interruption reconciles remote bytes after every local copy was removed',async t=>{
 const f=await fixture(t),s3=memoryArchive();
 const engine=new RotationEngine(f.config,f.store,{s3,checkpoint:async phase=>{if(phase==='uploaded')throw new Error('legacy interruption');}});
 await engine.createSource(f.source,'test');await assert.rejects(engine.rotate('synthetic','test'),/legacy interruption/);
 for(const directory of [path.join(f.dirs.spool,'synthetic'),path.join(f.dirs.archive,'synthetic')])for(const file of await readdir(directory))await rm(path.join(directory,file));
 const bytes=f.store.snapshot();bytes.schemaVersion=1;delete bytes.rotations;
 await writeFile(path.join(f.dirs.state,'state.json'),JSON.stringify(bytes));
 const restored=new StateStore(f.config);await restored.load();const retry=new RotationEngine(f.config,restored,{s3});
 assert.equal((await retry.retryPending('test'))[0].result,'completed');assert.equal((await retry.verifyRestore('test')).restoredRecords,2);
 assert.equal(restored.snapshot().schemaVersion,2);assert.equal(s3.objects.size,2);
 const clean=path.join(f.dirs.state,'clean');await mkdir(clean);await writeFile(path.join(clean,'state.json'),JSON.stringify(restored.snapshot()));
 const cleanStore=new StateStore({...f.config,dataDir:clean});await cleanStore.load();
 assert.equal((await new RotationEngine(f.config,cleanStore,{s3}).verifyRestore('test')).result,'passed');
});

test('invalid JSONL fails restore verification and records failure without retaining content',async t=>{
 const f=await fixture(t);await writeFile(f.active,'{broken-json}\n');const engine=new RotationEngine(f.config,f.store);
 await engine.createSource(f.source,'test');await engine.rotate('synthetic','test');
 await assert.rejects(engine.verifyRestore('test'),/JSONL record is invalid/);
 assert.equal(f.store.snapshot().restoreVerifications.at(-1).result,'failed');
 assert.equal((await readdir(f.dirs.spool)).filter(n=>n.startsWith('restore-')).length,0);
});
