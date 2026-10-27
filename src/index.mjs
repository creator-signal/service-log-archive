import { loadConfig } from "./config.mjs";
import { StateStore } from "./state.mjs";
import { Authenticator } from "./auth.mjs";
import { RotationEngine } from "./rotation.mjs";
import { createLogArchiveServer } from "./server.mjs";
import {acquireRotationOwnership,guardRotationOwnership} from './ownership.mjs';

let owner,engine,server;
try {
  const config=await loadConfig();
  // Ownership precedes migration, recovery, credentials, scheduling and HTTP.
  owner=await acquireRotationOwnership(config);
  const store=new StateStore(config);await store.load();
  const auth=new Authenticator(config);await auth.load();
  engine=new RotationEngine(config,store,{checkpoint:()=>owner.assertHeld()});
  guardRotationOwnership(owner,{store,engine});
  await engine.start();
  server=createLogArchiveServer({config,store,auth,engine,beforeRequest:()=>owner.assertHeld()});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
  console.log(JSON.stringify({level:'info',event:'service.ready',host:config.host,port:config.port}));
  let stopping;
  const shutdown=()=>stopping??=(async()=>{
    const deadline=setTimeout(()=>process.exit(1),10_000);deadline.unref();
    const requests=new Promise(resolve=>server.close(error=>resolve(error)));
    const results=await Promise.allSettled([engine.stop(),requests]);
    // Await both drains before releasing, including when one fails.
    await owner.release();clearTimeout(deadline);
    process.exit(results.some(row=>row.status==='rejected'||row.value instanceof Error)?1:0);
  })().catch(()=>{console.error(JSON.stringify({level:'error',event:'service.shutdown_denied'}));process.exit(1);});
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
} catch(error) {
  await engine?.stop().catch(()=>{});
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  await owner?.release().catch(()=>{});
  const ownership=error?.code==='ROTATION_OWNER_UNAVAILABLE';
  console.error(JSON.stringify({level:'error',event:ownership?'service.ownership_denied':'service.startup_denied'}));
  process.exitCode=ownership?75:1;
}

