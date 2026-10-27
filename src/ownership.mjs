import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const denied=()=>Object.assign(new Error('rotation_owner_unavailable'),{code:'ROTATION_OWNER_UNAVAILABLE',status:503});

// Embedders acquire before state migration and retain ownership until HTTP
// work and engine.stop() drain. Check inside the durable mutation queue too.
export function guardRotationOwnership(owner,{store,engine}) {
  const mutate=store.mutate.bind(store);
  store.mutate=mutator=>mutate(async state=>{
    await owner.assertHeld();
    const result=await mutator(state);
    await owner.assertHeld();
    return result;
  });
  for(const method of ['createSource','updateSource','deleteSource','rotate','tick','retryPending','archiveSegment','verifyRestore']) {
    const operation=engine[method].bind(engine);
    engine[method]=async(...args)=>{await owner.assertHeld();return operation(...args);};
  }
}

// The short flock child shares the parent's open-file description through FD3.
// Its exit leaves the kernel lock held by this process until close or death.
// Never unlink a lock, infer ownership from a PID, or replace an existing inode.
export async function acquireRotationOwnership(config) {
  let handle;
  try {
    assert.equal(process.platform,'linux');
    const external=config.externalRotationLock===true;
    const filename=config.rotationLockFile??path.join(config.dataDir,'.rotation-owner.lock');
    assert.ok(path.isAbsolute(filename)&&path.normalize(filename)===filename);
    const parent=path.dirname(filename);
    assert.equal(await realpath(parent),parent);
    const directory=await lstat(parent);
    assert.ok(directory.isDirectory()&&!directory.isSymbolicLink());
    assert.ok([0,process.getuid()].includes(directory.uid)&&(directory.mode&0o022)===0);
    if(external)handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    else {
      try{handle=await open(filename,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
      catch(error){if(error.code!=='EEXIST')throw error;handle=await open(filename,constants.O_RDWR|constants.O_NOFOLLOW);}
    }
    const original=await handle.stat();
    const validate=metadata=>{
      assert.ok(metadata.isFile()&&!metadata.isSymbolicLink()&&metadata.nlink===1&&metadata.size<=4096);
      assert.ok([0,process.getuid()].includes(metadata.uid)&&(metadata.mode&0o022)===0);
      if(!external)assert.ok(metadata.uid===process.getuid()&&(metadata.mode&0o077)===0);
    };
    validate(original);
    let closed=false;
    const assertHeld=async()=>{
      try {
        assert.equal(closed,false);
        assert.equal(await realpath(parent),parent);
        const currentDirectory=await lstat(parent);
        assert.ok(currentDirectory.isDirectory()&&!currentDirectory.isSymbolicLink()&&(currentDirectory.mode&0o022)===0);
        for(const key of ['dev','ino','uid','gid','mode'])assert.equal(currentDirectory[key],directory[key]);
        const current=await lstat(filename),opened=await handle.stat();
        for(const metadata of [current,opened]) {
          validate(metadata);
          for(const key of ['dev','ino','uid','gid','mode','size','mtimeMs','ctimeMs'])assert.equal(metadata[key],original[key]);
        }
      } catch {throw denied();}
    };
    await assertHeld();
    execFileSync('flock',['-x','-n','3'],{stdio:['ignore','ignore','pipe',handle.fd],timeout:5000,
      env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
    await assertHeld();
    return Object.freeze({assertHeld,release:async()=>{if(!closed){closed=true;await handle.close();}}});
  } catch {
    await handle?.close().catch(()=>{});
    throw denied();
  }
}
