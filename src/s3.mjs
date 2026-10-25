import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {createReadStream,createWriteStream} from "node:fs";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {syncFile} from "./durable.mjs";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encodePath = (value) => value.split("/").map((part) => encodeURIComponent(part)).join("/");

export class S3Archive {
  #config;
  #fetch;

  constructor(config, fetchImplementation = fetch) {
    this.#config = config.s3;
    this.#fetch = fetchImplementation;
  }

  get enabled() { return this.#config.enabled; }

  async upload(file, sourceId, checksum, contentType) {
    if (!this.enabled) return null;
    const objectName = `${this.#config.prefix}/${sourceId}/${path.basename(file)}`;
    const size=(await stat(file)).size;
    const metadata = { "content-type": contentType, "if-none-match": "*", "x-amz-meta-sha256": checksum, "content-length":String(size) };
    const body=createReadStream(file);
    let response;
    try{response=await this.#request("PUT",objectName,body,metadata,checksum);}
    finally{body.destroy();}
    if(!response.ok&&response.status!==412)throw new Error(await responseProblem('immutable upload',response));
    await response.body?.cancel();
    return this.verify(objectName,checksum,size);
  }

  async verify(objectName,checksum,size){
    if(!this.enabled)throw new Error('S3 archive is not enabled');
    this.#assertKey(objectName);
    let response=await this.#request('HEAD',objectName,Buffer.alloc(0),{});
    if(!response.ok)throw new Error(await responseProblem('verification',response));
    if(response.headers.get('x-amz-meta-sha256')!==checksum||Number(response.headers.get('content-length'))!==size)throw new Error('S3 object metadata differs');
    const etag=response.headers.get('etag');
    response=await this.#request('GET',objectName,Buffer.alloc(0),{});
    if(!response.ok)throw new Error(await responseProblem('byte verification',response));
    await consumeVerified(response,checksum,size);
    return {key:objectName,etag,verifiedAt:new Date().toISOString()};
  }

  key(sourceId,filename){return `${this.#config.prefix}/${sourceId}/${path.basename(filename)}`;}

  #assertKey(objectName){
    if(!objectName.startsWith(this.#config.prefix+'/')||objectName.split('/').some(part=>part==='.'||part==='..'))throw new Error('Archive key escaped configured prefix');
  }

  async download(objectName,destination,checksum,maximum=Number.MAX_SAFE_INTEGER){
    if(!this.enabled)throw new Error('S3 archive is not enabled');
    this.#assertKey(objectName);
    const response=await this.#request('GET',objectName,Buffer.alloc(0),{});
    if(!response.ok)throw new Error(await responseProblem('restore download',response));
    await consumeVerified(response,checksum,maximum,createWriteStream(destination,{flags:'wx',mode:0o600}));
    await syncFile(destination);
    return destination;
  }

  async #request(method, objectName, body, additionalHeaders, knownHash) {
    const credentials = await this.#credentials();
    const endpoint = new URL(this.#config.endpoint);
    const canonicalUri = `${endpoint.pathname.replace(/\/$/, "")}/${encodePath(this.#config.bucket)}/${encodePath(objectName)}`.replace(/^([^/])/, "/$1");
    const target = new URL(endpoint);
    target.pathname = canonicalUri;
    target.search = "";

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = knownHash ?? hash(body);
    const headers = {
      host: target.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...additionalHeaders,
    };
    const headerNames = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = headerNames.map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}`).join("\n");
    const signedHeaders = headerNames.join(";");
    const canonicalRequest = [method, canonicalUri, "", `${canonicalHeaders}\n`, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${this.#config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hash(canonicalRequest)].join("\n");
    const dateKey = hmac(Buffer.from(`AWS4${credentials.secretKey}`), date);
    const regionKey = hmac(dateKey, this.#config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host;
    return this.#fetch(target, { method, headers, body: method === "PUT" ? body : undefined, ...(method === "PUT" ? {duplex:"half"} : {}), signal: AbortSignal.timeout(30_000) });
  }

  async #credentials() {
    const [accessKey, secretKey] = await Promise.all([
      readFile(this.#config.accessKeyFile, "utf8"),
      readFile(this.#config.secretKeyFile, "utf8"),
    ]);
    if (!accessKey.trim() || !secretKey.trim()) throw new Error("S3 credential files must not be empty");
    return { accessKey: accessKey.trim(), secretKey: secretKey.trim() };
  }
}

async function responseProblem(operation, response) {
  // Provider error bodies can contain private paths or arbitrary unbounded data.
  await response.body?.cancel();
  return `S3 ${operation} failed with ${response.status}`;
}

async function consumeVerified(response,checksum,maximum,destination){
  if(!/^[a-f0-9]{64}$/.test(checksum))throw new Error('Invalid expected archive checksum');
  const hash=createHash('sha256');let size=0;
  if(!response.body)throw new Error('Archive response body missing');
  const source=Readable.fromWeb(response.body);
  const checked=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>maximum)return callback(new Error('Archive object exceeds expected bound'));hash.update(chunk);callback(null,chunk);}});
  const sink=destination??new Transform({transform(chunk,encoding,callback){callback();}});
  await pipeline(source,checked,sink);
  if(hash.digest('hex')!==checksum)throw new Error('S3 byte checksum does not match manifest');
}
