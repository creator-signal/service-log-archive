import {Transform} from 'node:stream';
import {createReadStream} from 'node:fs';
export function byteLimit(maximum){
  if(!Number.isSafeInteger(maximum)||maximum<0)throw new Error('Invalid restored byte bound');
  let bytes=0;
  return new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>maximum?new Error('Restored content exceeds manifest bound'):null,chunk);}});
}
export async function verifyJsonl(filename){
  const decoder=new TextDecoder('utf-8',{fatal:true});let partial='',records=0;
  function record(line){
    if(!line.trim())return;
    try{const value=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();}
    catch{throw new Error('Restored JSONL record is invalid');}
    records++;
  }
  for await(const bytes of createReadStream(filename)){
    partial+=decoder.decode(bytes,{stream:true});
    let at;while((at=partial.indexOf('\n'))>=0){const line=partial.slice(0,at);if(Buffer.byteLength(line)>1048576)throw new Error('Restored JSONL line exceeds bound');record(line);partial=partial.slice(at+1);}
    if(Buffer.byteLength(partial)>1048576)throw new Error('Restored JSONL line exceeds bound');
  }
  partial+=decoder.decode();if(partial)record(partial);
  return records;
}
