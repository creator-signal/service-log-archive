import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,rename,rm} from 'node:fs/promises';
import path from 'node:path';

export async function syncDirectory(directory) {
  if(process.platform==='win32')return;
  const handle=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await handle.sync();}finally{await handle.close();}
}

export async function durableWrite(filename,bytes,{mode=0o600}={}) {
  const temporary=`${filename}.next-${randomUUID()}`;
  let handle;
  try{
    handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);
    await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;
    for(let attempt=0;;attempt++){
      try{await rename(temporary,filename);break;}
      catch(error){
        if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(error.code)||attempt===4)throw error;
        await new Promise(resolve=>setTimeout(resolve,10*2**attempt));
      }
    }
    await syncDirectory(path.dirname(filename));
  }finally{if(handle)await handle.close();await rm(temporary,{force:true});}
}

export async function syncFile(filename) {
  const handle=await open(filename,constants.O_RDWR|constants.O_NOFOLLOW);
  try{await handle.sync();}finally{await handle.close();}
}
