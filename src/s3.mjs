import { createHash, createHmac } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
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
    const body = await readFile(file);
    const metadata = { "content-type": contentType, "if-none-match": "*", "x-amz-meta-sha256": checksum };
    let response = await this.#request("PUT", objectName, body, metadata);
    if (!response.ok && response.status !== 412) throw new Error(await responseProblem("immutable upload", response));

    response = await this.#request("HEAD", objectName, Buffer.alloc(0), {});
    if (!response.ok) throw new Error(await responseProblem("verification", response));
    if (response.headers.get("x-amz-meta-sha256") !== checksum) throw new Error("S3 checksum metadata does not match");
    if (Number(response.headers.get("content-length")) !== (await stat(file)).size) throw new Error("S3 content length does not match");
    return { key: objectName, etag: response.headers.get("etag"), verifiedAt: new Date().toISOString() };
  }

  async download(objectName, destination, checksum) {
    if (!this.enabled) throw new Error("S3 archive is not enabled");
    const response = await this.#request("GET", objectName, Buffer.alloc(0), {});
    if (!response.ok) throw new Error(await responseProblem("restore download", response));
    const body = Buffer.from(await response.arrayBuffer());
    if (hash(body) !== checksum) throw new Error("S3 restore checksum does not match manifest");
    await writeFile(destination, body, { mode: 0o600, flag: "wx" });
    return destination;
  }

  async #request(method, objectName, body, additionalHeaders) {
    const credentials = await this.#credentials();
    const endpoint = new URL(this.#config.endpoint);
    const canonicalUri = `${endpoint.pathname.replace(/\/$/, "")}/${encodePath(this.#config.bucket)}/${encodePath(objectName)}`.replace(/^([^/])/, "/$1");
    const target = new URL(endpoint);
    target.pathname = canonicalUri;
    target.search = "";

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = hash(body);
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
    return this.#fetch(target, { method, headers, body: method === "PUT" ? body : undefined, signal: AbortSignal.timeout(30_000) });
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
  const text = await response.text();
  const code = text.match(/<Code>([^<]{1,100})<\/Code>/)?.[1];
  const resource = text.match(/<Resource>([^<]{1,300})<\/Resource>/)?.[1];
  return `S3 ${operation} failed with ${response.status}${code ? ` ${code}` : ""}${resource ? ` for ${resource}` : ""}`;
}
