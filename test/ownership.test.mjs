import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rename,link,symlink,rm,lstat} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createServer as createPortAllocator,createConnection} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {acquireRotationOwnership,guardRotationOwnership} from '../src/ownership.mjs';
import {loadConfig} from '../src/config.mjs';
import {StateStore} from '../src/state.mjs';
import {RotationEngine} from '../src/rotation.mjs';
import {createLogArchiveServer} from '../src/server.mjs';

const native={skip:process.platform!=='linux'};
const moduleUrl=new URL('../src/ownership.mjs',import.meta.url).href;
async function fixture(){
  const parent=fileURLToPath(new URL('../.tmp/',import.meta.url));await mkdir(parent,{recursive:true});
  return mkdtemp(path.join(parent,'ownership-'));
}
const contender=config=>spawnSync(process.execPath,['--input-type=module','-e',
  `import {acquireRotationOwnership} from ${JSON.stringify(moduleUrl)};try{const owner=await acquireRotationOwnership(JSON.parse(process.argv[1]));await owner.release();process.exitCode=0;}catch{process.exitCode=75;}`,
  JSON.stringify(config)],{encoding:'utf8',timeout:5000});

test('kernel ownership survives the flock child and excludes an actual second Node process',native,async()=>{
  const root=await fixture();let owner;
  try{
    const config={dataDir:root};owner=await acquireRotationOwnership(config);
    const filename=path.join(root,'.rotation-owner.lock'),before=await readFile(filename);
    assert.equal((await lstat(filename)).mode&0o777,0o600);
    assert.equal(contender(config).status,75);
    await owner.assertHeld();await owner.release();await owner.release();
    assert.equal(contender(config).status,0);assert.deepEqual(await readFile(filename),before);
    await assert.rejects(owner.assertHeld(),{code:'ROTATION_OWNER_UNAVAILABLE'});
  }finally{await owner?.release();await rm(root,{recursive:true});}
});

test('external read-only lock is never created, truncated or unlinked',native,async()=>{
  const root=await fixture();let owner;
  try{
    const filename=path.join(root,'external.lock'),config={dataDir:root,rotationLockFile:filename,externalRotationLock:true};
    await assert.rejects(acquireRotationOwnership(config),{code:'ROTATION_OWNER_UNAVAILABLE'});
    await assert.rejects(lstat(filename),{code:'ENOENT'});
    await writeFile(filename,'synthetic-stable-lock',{mode:0o440});
    owner=await acquireRotationOwnership(config);
    assert.equal(contender(config).status,75);assert.equal(await readFile(filename,'utf8'),'synthetic-stable-lock');
    await owner.release();assert.equal(contender(config).status,0);
    assert.equal(await readFile(filename,'utf8'),'synthetic-stable-lock');
  }finally{await owner?.release();await chmod(path.join(root,'external.lock'),0o600).catch(()=>{});await rm(root,{recursive:true});}
});

test('owner loss, path replacement, symlinks, hardlinks and unsafe custody fail closed',native,async()=>{
  for(const fault of ['replace','bytes','symlink','hardlink','permissions','parent-mode']){
    const root=await fixture();let owner;
    try{
      const filename=path.join(root,'.rotation-owner.lock');owner=await acquireRotationOwnership({dataDir:root});
      if(fault==='replace'){await rename(filename,filename+'.old');await writeFile(filename,'',{mode:0o600});}
      if(fault==='bytes')await writeFile(filename,'changed');
      if(fault==='symlink'){await rename(filename,filename+'.old');await symlink(filename+'.old',filename);}
      if(fault==='hardlink')await link(filename,filename+'.other');
      if(fault==='permissions')await chmod(filename,0o666);
      if(fault==='parent-mode')await chmod(root,0o777);
      await assert.rejects(owner.assertHeld(),error=>error.code==='ROTATION_OWNER_UNAVAILABLE'&&error.status===503&&!error.message.includes(root));
      if(fault!=='replace'&&fault!=='bytes')await assert.rejects(acquireRotationOwnership({dataDir:root}),{code:'ROTATION_OWNER_UNAVAILABLE'});
    }finally{await owner?.release();await rm(root,{recursive:true});}
  }
});

test('process death releases the kernel lock without deleting stale files',native,async()=>{
  const root=await fixture();let child;
  try{
    child=spawn(process.execPath,['--input-type=module','-e',
      `import {acquireRotationOwnership} from ${JSON.stringify(moduleUrl)};const owner=await acquireRotationOwnership({dataDir:process.argv[1]});console.log('ready');setInterval(()=>owner.assertHeld().catch(()=>process.exit(1)),1000);`,root],{stdio:['ignore','pipe','pipe']});
    const ended=once(child,'exit');
    const ready=await Promise.race([once(child.stdout,'data'),ended.then(()=>{throw new Error('synthetic owner exited before readiness');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('synthetic owner deadline')),5000);timer.unref();})]);
    assert.equal(ready[0].toString().trim(),'ready');
    assert.equal(contender({dataDir:root}).status,75);
    child.kill('SIGKILL');await ended;
    assert.equal(contender({dataDir:root}).status,0);
    assert.equal((await lstat(path.join(root,'.rotation-owner.lock'))).nlink,1);
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}await rm(root,{recursive:true});}
});

test('queued ledger mutation checks current ownership at execution time',async()=>{
  const root=await fixture();let release;
  try{
    const config=await loadConfig({LOG_ARCHIVE_DATA_DIR:root+'/state',LOG_ARCHIVE_SPOOL_DIR:root+'/spool',LOG_ARCHIVE_ARCHIVE_DIR:root+'/archive',LOG_ARCHIVE_ALLOWED_ROOTS:root+'/logs'});
    const store=new StateStore(config);await store.load();
    const initial=await readFile(path.join(config.dataDir,'state.json'));
    let owned=true;
    const engine=new RotationEngine(config,store),owner={assertHeld:async()=>{assert.ok(owned,'synthetic ownership lost');}};
    const blocker=store.mutate(async()=>{await new Promise(resolve=>{release=resolve;});});
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    guardRotationOwnership(owner,{store,engine});
    const queued=store.mutate(state=>{state.audit.push({private:'must not persist'});});
    const denied=assert.rejects(queued,/synthetic ownership lost/u);
    owned=false;release();await blocker;await denied;
    assert.equal(store.snapshot().audit.length,0);
    assert.doesNotMatch((await readFile(path.join(config.dataDir,'state.json'))).toString(),/must not persist/u);
    assert.ok(initial.length>0);
    await assert.rejects(engine.retryPending('synthetic'),/synthetic ownership lost/u);
  }finally{release?.();await rm(root,{recursive:true});}
});

test('readiness and management deny lost ownership without exposing private diagnostics',async()=>{
  const server=createLogArchiveServer({config:{rateLimitPerMinute:100},store:{snapshot:()=>({revision:1})},auth:{},engine:{},logger:{error:()=>{throw new Error('unexpected private logger use');}},
    beforeRequest:async()=>{throw Object.assign(new Error('rotation_owner_unavailable'),{status:503});}});
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    for(const route of ['/readyz','/api/v1/sources']){
      const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`);assert.equal(response.status,503);
      assert.equal((await response.json()).detail,'rotation_owner_unavailable');
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('service locks before recovery and retains ownership until an accepted HTTP request drains',native,async()=>{
  const root=await fixture();let child,socket;
  try{
    const config=await loadConfig({LOG_ARCHIVE_DATA_DIR:root+'/state',LOG_ARCHIVE_SPOOL_DIR:root+'/spool',LOG_ARCHIVE_ARCHIVE_DIR:root+'/archive',LOG_ARCHIVE_ALLOWED_ROOTS:root+'/logs'});
    const token='synthetic-owner-token',tokenFile=root+'/tokens.json';
    await writeFile(tokenFile,JSON.stringify({tokens:[{id:'synthetic',role:'administrator',sha256:createHash('sha256').update(token).digest('hex')}]}));
    const allocator=createPortAllocator();await new Promise(resolve=>allocator.listen(0,'127.0.0.1',resolve));
    const port=allocator.address().port;await new Promise(resolve=>allocator.close(resolve));
    const environment={...process.env,LOG_ARCHIVE_DATA_DIR:config.dataDir,LOG_ARCHIVE_SPOOL_DIR:config.spoolDir,LOG_ARCHIVE_ARCHIVE_DIR:config.archiveDir,
      LOG_ARCHIVE_ALLOWED_ROOTS:root+'/logs',LOG_ARCHIVE_TOKEN_FILE:tokenFile,LOG_ARCHIVE_HOST:'127.0.0.1',LOG_ARCHIVE_PORT:String(port),
      LOG_ARCHIVE_ROTATION_LOCK_FILE:'',LOG_ARCHIVE_S3_ENDPOINT:'',LOG_ARCHIVE_OIDC_ISSUER:''};
    const entry=fileURLToPath(new URL('../src/index.mjs',import.meta.url));
    child=spawn(process.execPath,[entry],{env:environment,stdio:['ignore','pipe','pipe']});
    const ended=once(child,'exit');
    const ready=await Promise.race([once(child.stdout,'data'),ended.then(()=>{throw new Error('synthetic service failed startup');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('synthetic service deadline')),5000);timer.unref();})]);
    assert.equal(JSON.parse(ready[0].toString()).event,'service.ready');
    const original=await readFile(path.join(config.dataDir,'state.json'));
    const rejected=spawnSync(process.execPath,[entry],{env:environment,encoding:'utf8',timeout:5000});
    assert.equal(rejected.status,75);assert.equal(JSON.parse(rejected.stderr.trim()).event,'service.ownership_denied');
    assert.doesNotMatch(rejected.stderr,new RegExp(token));assert.ok(!rejected.stderr.includes(root));
    assert.deepEqual(await readFile(path.join(config.dataDir,'state.json')),original,'contender changed state before ownership');
    const payload=JSON.stringify({id:'drain-fixture',path:root+'/logs/synthetic.log',maxBytes:1024,intervalSeconds:0});
    await writeFile(root+'/logs/synthetic.log','synthetic\n');
    socket=createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});socket.resume();await once(socket,'connect');
    socket.write(`POST /api/v1/sources HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload.slice(0,1)}`);
    await new Promise(resolve=>setTimeout(resolve,100));child.kill('SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(child.exitCode,null,'service released before the accepted request drained');
    assert.equal(contender(config).status,75);
    socket.end(payload.slice(1));const [code]=await ended;assert.equal(code,0);
    assert.equal(contender(config).status,0);
    const state=JSON.parse(await readFile(path.join(config.dataDir,'state.json')));
    assert.ok(state.sources.some(row=>row.id==='drain-fixture'));
  }finally{
    socket?.destroy();
    if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}
    await rm(root,{recursive:true});
  }
});
