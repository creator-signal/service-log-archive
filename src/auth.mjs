import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const roles = Object.freeze({ viewer: 1, operator: 2, administrator: 3 });

const decode = (value) => Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const sha256 = (value) => createHash("sha256").update(value).digest();

export class Authenticator {
  #config;
  #tokens = [];
  #oidc = { expiresAt: 0, issuer: null, jwks: [] };

  constructor(config) {
    this.#config = config;
  }

  async load() {
    const document = JSON.parse(await readFile(this.#config.tokenFile, "utf8"));
    if (!Array.isArray(document.tokens) || document.tokens.length === 0) {
      throw new Error("Token file must define at least one scoped token");
    }
    this.#tokens = document.tokens.map((entry) => {
      if (!entry.id || !roles[entry.role] || !/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
        throw new Error("Each token requires id, sha256, and a valid role");
      }
      return { id: entry.id, role: entry.role, digest: Buffer.from(entry.sha256, "hex") };
    });
  }

  async authenticate(header) {
    if (!header?.startsWith("Bearer ")) return null;
    const credential = header.slice(7).trim();
    if (!credential) return null;

    const digest = sha256(credential);
    const token = this.#tokens.find((candidate) => timingSafeEqual(candidate.digest, digest));
    if (token) return { subject: `token:${token.id}`, role: token.role, method: "token" };

    if (this.#config.oidcIssuer && credential.split(".").length === 3) {
      return this.#verifyOidc(credential);
    }
    return null;
  }

  authorize(identity, required) {
    return Boolean(identity && roles[identity.role] >= roles[required]);
  }

  async #verifyOidc(jwt) {
    const [encodedHeader, encodedPayload, signature] = jwt.split(".");
    const header = JSON.parse(decode(encodedHeader));
    const payload = JSON.parse(decode(encodedPayload));
    if (header.alg !== "RS256" || !header.kid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== this.#config.oidcIssuer || payload.exp <= now || (payload.nbf && payload.nbf > now)) return null;
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (this.#config.oidcAudience && !audience.includes(this.#config.oidcAudience)) return null;

    const jwks = await this.#loadJwks();
    const jwk = jwks.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return null;
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      decode(signature),
    );
    if (!valid) return null;

    const claim = payload[this.#config.oidcRoleClaim];
    const candidates = Array.isArray(claim) ? claim : [claim];
    const role = ["administrator", "operator", "viewer"].find((candidate) => candidates.includes(candidate));
    return role && payload.sub ? { subject: `oidc:${payload.sub}`, role, method: "oidc" } : null;
  }

  async #loadJwks() {
    if (Date.now() < this.#oidc.expiresAt) return this.#oidc.jwks;
    const discoveryResponse = await fetch(`${this.#config.oidcIssuer}/.well-known/openid-configuration`);
    if (!discoveryResponse.ok) throw new Error("OIDC discovery failed");
    const discovery = await discoveryResponse.json();
    if (!discovery.jwks_uri?.startsWith(`${this.#config.oidcIssuer}/`)) throw new Error("OIDC jwks_uri is outside issuer");
    const jwksResponse = await fetch(discovery.jwks_uri);
    if (!jwksResponse.ok) throw new Error("OIDC JWKS request failed");
    const document = await jwksResponse.json();
    this.#oidc = { expiresAt: Date.now() + 5 * 60_000, issuer: this.#config.oidcIssuer, jwks: document.keys || [] };
    return this.#oidc.jwks;
  }
}

export function hashToken(token) {
  return sha256(token).toString("hex");
}

