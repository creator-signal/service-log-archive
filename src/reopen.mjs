import {readFile,readdir,stat} from 'node:fs/promises';
const same=(a,b)=>String(a.dev)===String(b.dev)&&String(a.ino)===String(b.ino);
async function observe(pid){
  if(process.platform!=='linux')throw new Error('Signal reopen verification requires Linux procfs');
  const text=await readFile(`/proc/${pid}/stat`,'utf8');
  const start=text.slice(text.lastIndexOf(')')+2).split(' ')[19];
  if(!/^\d+$/.test(start??''))throw new Error('Producer process identity unavailable');
  const names=await readdir(`/proc/${pid}/fd`);
  if(names.length>4096)throw new Error('Producer descriptor inventory exceeds bound');
  const files=[];
  for(const name of names){
    if(!/^\d+$/.test(name))continue;
    try{files.push(await stat(`/proc/${pid}/fd/${name}`));}
    catch(error){if(error.code!=='ENOENT')throw new Error('Producer descriptors cannot be verified');}
  }
  const after=await readFile(`/proc/${pid}/stat`,'utf8');
  if(after.slice(after.lastIndexOf(')')+2).split(' ')[19]!==start)throw new Error('Producer changed during observation');
  return {start,files};
}
export const pidProducer={
  async capture(source,before){
    const value=await observe(source.reopenPid);
    if(!value.files.some(file=>same(file,before)))throw new Error('Producer does not own the active inode');
    return {start:value.start};
  },
  async verify(source,before,replacement,identity){
    const deadline=Date.now()+(source.reopenTimeoutMs??5000);
    do{
      const value=await observe(source.reopenPid);
      // A restarted producer can be adopted only after it already owns the
      // exact replacement and no longer owns the retained original inode.
      if(value.files.some(file=>same(file,replacement))&&!value.files.some(file=>same(file,before)))return {start:value.start};
      if(value.start!==identity.start)throw new Error('Producer identity changed before verified reopen');
      await new Promise(resolve=>setTimeout(resolve,25));
    }while(Date.now()<deadline);
    throw new Error('Producer reopen was not acknowledged before timeout');
  },
};
