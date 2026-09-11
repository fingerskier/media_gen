import { test, expect, vi } from "vitest";
import {
  validateDestination,
  createTransport,
  RequestRejected,
} from "../src/main/network";
test("outbound boundary pins public HTTPS addresses and rejects private/redirect credential hazards", async () => {
  const publicDNS = vi.fn(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  expect(
    (await validateDestination("https://cdn.example/a", publicDNS)).address,
  ).toBe("93.184.216.34");
  for (const url of [
    "http://cdn.example/a",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://[::ffff:127.0.0.1]/a",
    "https://user:pass@cdn.example/a",
    "https://cdn.example:8443/a",
  ])
    await expect(validateDestination(url, publicDNS)).rejects.toThrow();
  await expect(
    validateDestination("https://cdn.example/a", async () => [
      { address: "169.254.169.254", family: 4 },
    ]),
  ).rejects.toThrow();
  const exchange = vi.fn(async (_url: string, _options: unknown) => ({
    status: 401,
    headers: {},
    bytes: Buffer.from('{"msg":"secret-token"}'),
  }));
  const request = createTransport(exchange);
  await expect(
    request("/generateImage", "private-key", {}),
  ).rejects.toBeInstanceOf(RequestRejected);
  try {
    await request("/generateImage", "private-key", {});
  } catch (e) {
    expect(String(e)).not.toContain("secret-token");
    expect(String(e)).not.toContain("private-key");
  }
  expect(exchange.mock.calls[0][0]).toBe(
    "https://api.atlascloud.ai/api/v1/model/generateImage",
  );
});

import { createRequestBytes } from "../src/main/network";
import { EventEmitter } from "node:events";
test("DNS resolution is bounded before an HTTPS socket is opened", async () => {
  const request = vi.fn();
  const exchange = createRequestBytes(
    () => new Promise(() => {}),
    request as never,
  );
  await expect(
    exchange("https://cdn.example/a", { maxBytes: 100, timeoutMs: 10 }),
  ).rejects.toThrow(/timed out/);
  expect(request).not.toHaveBeenCalled();
});
test("request pins validated public DNS and does not follow a POST redirect", async () => {
  const request = vi.fn((_url: URL, options: any, callback: Function) => {
    options.lookup(
      "cdn.example",
      {},
      (error: unknown, address: string, family: number) => {
        expect(error).toBeNull();
        expect(address).toBe("93.184.216.34");
        expect(family).toBe(4);
      },
    );
    const req = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: vi.fn(),
      end() {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 307,
          headers: { location: "https://evil.example" },
          destroy: vi.fn(),
        });
        callback(res);
        res.emit("end");
        req.emit("close");
      },
    });
    return req;
  });
  const exchange = createRequestBytes(
    async () => [{ address: "93.184.216.34", family: 4 }],
    request as never,
  );
  await expect(
    createTransport(exchange)("/generateImage", "fixture-key", {}),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
  const blocked = createRequestBytes(
    async () => [{ address: "127.0.0.1", family: 4 }],
    request as never,
  );
  await expect(
    blocked("https://cdn.example", { maxBytes: 100 }),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
test("Retry-After is preserved without leaking response bodies", async () => {
  const exchange = async () => ({
    status: 429,
    headers: { "retry-after": "999999" },
    bytes: Buffer.from("secret signed url"),
  });
  try {
    await createTransport(exchange)("/prediction/same", "fixture");
  } catch (error) {
    expect(error).toBeInstanceOf(RequestRejected);
    expect((error as RequestRejected).retryAfterMs).toBe(999999000);
    expect(String(error)).not.toContain("secret");
  }
});

import { createDownloader } from "../src/main/media";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test.each([
  "https://user:secret@cdn.example/output",
  "https://127.0.0.1/output",
  "https://private.example/output",
])("download revalidates redirected destination %s", async (location) => {
  const request = vi.fn((_url: URL, _options: unknown, callback: Function) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end() {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 302,
          headers: { location },
          destroy: vi.fn(),
        });
        callback(res);
        res.emit("end");
        req.emit("close");
      },
    });
    return req;
  });
  const exchange = createRequestBytes(
    async (host) => [
      {
        address: host === "private.example" ? "10.0.0.1" : "93.184.216.34",
        family: 4,
      },
    ],
    request as never,
  );
  await expect(
    createDownloader(mkdtempSync(join(tmpdir(), "media-redirect-")), exchange)(
      "https://cdn.example/a",
      "image",
    ),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
test.each(["declared", "streamed"])(
  "request rejects oversized %s response at socket boundary",
  async (kind) => {
    const request = vi.fn(
      (_url: URL, _options: unknown, callback: Function) => {
        const req = Object.assign(new EventEmitter(), {
          destroy(error: Error) {
            req.emit("error", error);
            req.emit("close");
          },
          end() {
            const res = Object.assign(new EventEmitter(), {
              statusCode: 200,
              headers: kind === "declared" ? { "content-length": "200" } : {},
              destroy: vi.fn(),
            });
            callback(res);
            if (kind === "streamed") res.emit("data", Buffer.alloc(200));
          },
        });
        return req;
      },
    );
    await expect(
      createRequestBytes(
        async () => [{ address: "93.184.216.34", family: 4 }],
        request as never,
      )("https://cdn.example/a", { maxBytes: 100 }),
    ).rejects.toThrow();
  },
);

import { parseRetryAfter } from "../src/main/network";
test("Retry-After preserves large seconds and HTTP dates with an injected clock", () => {
  const now = Date.UTC(2026, 8, 11);
  expect(parseRetryAfter("600", now)).toBe(600000);
  expect(parseRetryAfter("999999", now)).toBe(999999000);
  expect(parseRetryAfter(new Date(now + 600000).toUTCString(), now)).toBe(
    600000,
  );
  expect(parseRetryAfter(new Date(now + 7200000).toUTCString(), now)).toBe(
    7200000,
  );
  expect(parseRetryAfter(new Date(now - 1000).toUTCString(), now)).toBe(0);
  expect(parseRetryAfter("invalid", now)).toBeUndefined();
});
