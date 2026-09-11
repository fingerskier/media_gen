import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { Transport } from "./atlas";
import type { CatalogFetch } from "./catalog";
import { LISTING_URL, SCHEMA_URL } from "./schema";

type Address = { address: string; family: number };
type Resolver = (host: string) => Promise<Address[]>;
export async function validateDestination(
  raw: string,
  resolver: Resolver = (host) => lookup(host, { all: true }),
): Promise<Address> {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw Error("HTTPS destination not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    throw Error("Local destination not allowed");
  const addresses = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv4" ? 4 : 6 }]
    : await resolver(host);
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !ipaddr.isValid(a.address) ||
        ipaddr.process(a.address).range() !== "unicast",
    )
  )
    throw Error("Non-public destination not allowed");
  return addresses[0];
}
export interface ExchangeResult {
  status: number;
  headers: Record<string, string | undefined>;
  bytes: Buffer;
}
export interface ExchangeOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  maxBytes: number;
  timeoutMs?: number;
}
export type Exchange = (
  url: string,
  options: ExchangeOptions,
) => Promise<ExchangeResult>;
// One request, no redirects: callers must explicitly decide redirect policy.
export function createRequestBytes(
  resolver?: Resolver,
  request: typeof https.request = https.request,
): Exchange {
  return async (raw, options) => {
    const started = Date.now(),
      timeout = Math.max(1, Math.min(options.timeoutMs ?? 30000, 120000));
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const address = await Promise.race([
      validateDestination(raw, resolver),
      new Promise<never>((_resolve, reject) => {
        dnsTimer = setTimeout(
          () => reject(Error("DNS resolution timed out")),
          timeout,
        );
      }),
    ]).finally(() => clearTimeout(dnsTimer));
    const url = new URL(raw);
    const remaining = timeout - (Date.now() - started);
    if (remaining <= 0) throw Error("Request timed out");
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: options.method ?? "GET",
          headers: options.headers,
          agent: false,
          // Pin the validated DNS answer while retaining the original TLS hostname/SNI.
          lookup: ((_host: unknown, opts: unknown, cb: Function) => {
            if ((opts as { all?: boolean }).all) cb(null, [address]);
            else cb(null, address.address, address.family);
          }) as never,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const declared = Number(res.headers["content-length"]);
          if (declared > options.maxBytes) {
            res.destroy();
            req.destroy(Error("Response exceeds size limit"));
            return;
          }
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > options.maxBytes) {
              res.destroy();
              req.destroy(Error("Response exceeds size limit"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => reject(Error("Response interrupted")));
          res.on("aborted", () => reject(Error("Response interrupted")));
          res.on("end", () => {
            const headers: Record<string, string | undefined> = {};
            for (const [key, value] of Object.entries(res.headers))
              headers[key] = Array.isArray(value) ? value.join(",") : value;
            resolve({
              status: res.statusCode ?? 0,
              headers,
              bytes: Buffer.concat(chunks),
            });
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(Error("Request timed out")),
        remaining,
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", () =>
        reject(Error("Network request failed or timed out")),
      );
      if (options.body) req.write(options.body);
      req.end();
    });
  };
}
export const requestBytes: Exchange = createRequestBytes();
export function parseRetryAfter(
  value: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+(\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
export class NetworkFailure extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
export class RequestRejected extends NetworkFailure {
  readonly safeMessage: string;
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message, retryAfterMs);
    this.safeMessage =
      /^Atlas (API key was rejected|rejected the parameters|account has insufficient balance|access is forbidden|model or request is unavailable|rate limit reached)\.$/.test(
        message,
      )
        ? message
        : "Atlas rejected the request.";
  }
}
export function createTransport(exchange: Exchange = requestBytes): Transport {
  return async (path, key, body) => {
    if (
      !/^\/(generateImage|generateVideo|prediction\/[a-zA-Z0-9_-]+)$/.test(path)
    )
      throw Error("Invalid API operation");
    const response = await exchange(
      "https://api.atlascloud.ai/api/v1/model" + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 30000,
      },
    );
    if (response.status >= 400 && response.status < 500) {
      const messages: Record<number, string> = {
        400: "Atlas rejected the parameters.",
        401: "Atlas API key was rejected.",
        402: "Atlas account has insufficient balance.",
        403: "Atlas access is forbidden.",
        404: "Atlas model or request is unavailable.",
        429: "Atlas rate limit reached.",
      };
      throw new RequestRejected(
        messages[response.status] ??
          `Atlas rejected request (HTTP ${response.status}).`,
        parseRetryAfter(response.headers["retry-after"]),
      );
    }
    if (response.status !== 200)
      throw new NetworkFailure(
        "Atlas request outcome could not be confirmed.",
        parseRetryAfter(response.headers["retry-after"]),
      );
    try {
      return JSON.parse(response.bytes.toString("utf8"));
    } catch {
      throw Error("Atlas returned unreadable data.");
    }
  };
}
// Public catalog documents only: no API key is ever attached to these hosts.
export function createCatalogFetch(
  exchange: Exchange = requestBytes,
): CatalogFetch {
  return async (url) => {
    if (url !== LISTING_URL && !SCHEMA_URL.test(url))
      throw Error("Invalid catalog URL");
    const response = await exchange(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: 30000,
    });
    if (response.status !== 200) throw Error("Atlas catalog is unavailable.");
    try {
      return JSON.parse(response.bytes.toString("utf8"));
    } catch {
      throw Error("Atlas returned unreadable catalog data.");
    }
  };
}
