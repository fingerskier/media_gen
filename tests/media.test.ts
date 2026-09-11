import { test, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDownloader,
  assetPath,
  serveFile,
  exportFile,
} from "../src/main/media";
test("downloaded PNG is saved atomically and local preview/ranges/export retain exact bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "media-files-"));
  const png = readFileSync("tests/fixtures/test-image.png");
  const exchange = vi.fn(async () => ({
    status: 200,
    headers: { "content-type": "image/png" },
    bytes: png,
  }));
  const asset = await createDownloader(root, exchange)(
    "https://cdn.example/a",
    "image",
  );
  const path = assetPath(root, asset.filename);
  expect(readFileSync(path)).toEqual(png);
  expect(asset.mime).toBe("image/png");
  const response = await serveFile(
    path,
    asset.mime,
    new Request("https://local.test", { headers: { Range: "bytes=1-9" } }),
  );
  expect(response.status).toBe(206);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(
    png.subarray(1, 10),
  );
  const dest = join(root, "export.png");
  await exportFile(path, dest);
  expect(readFileSync(dest)).toEqual(png);
  expect(() => assetPath(root, "../../etc/passwd")).toThrow();
  const invalid = await serveFile(
    path,
    asset.mime,
    new Request("https://local.test", { headers: { Range: "bytes=999999-" } }),
  );
  expect(invalid.status).toBe(416);
});

import { readdirSync } from "node:fs";
test.each(["png", "mp4"])(
  "rejects a malformed 24-byte %s despite its valid signature",
  async (extension) => {
    const root = mkdtempSync(join(tmpdir(), "media-malformed-"));
    const bytes = Buffer.alloc(24);
    if (extension === "png")
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    else bytes.write("ftyp", 4);
    const download = createDownloader(root, async () => ({
      status: 200,
      headers: {},
      bytes,
    }));
    await expect(
      download(
        "https://cdn.example/output",
        extension === "png" ? "image" : "video",
      ),
    ).rejects.toThrow();
    expect(readdirSync(join(root, "assets"))).toEqual([]);
  },
);

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { symlinkSync, mkdirSync, existsSync } from "node:fs";
test("real MP4 is probed for dimensions and duration with byte-identical storage; truncation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "media-video-"));
  const source = join(root, "fixture.mp4");
  await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=32x24:r=5",
      "-t",
      "0.4",
      "-c:v",
      "mpeg4",
      source,
    ],
    { timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  const bytes = readFileSync(source);
  const download = createDownloader(root, async () => ({
    status: 200,
    headers: { "content-type": "video/mp4" },
    bytes,
  }));
  const asset = await download("https://cdn.example/video", "video");
  expect(asset.width).toBe(32);
  expect(asset.height).toBe(24);
  expect(asset.duration).toBeCloseTo(0.4);
  expect(readFileSync(assetPath(root, asset.filename))).toEqual(bytes);
  await expect(
    createDownloader(root, async () => ({
      status: 200,
      headers: {},
      bytes: bytes.subarray(0, bytes.length / 2),
    }))("https://cdn.example/truncated", "video"),
  ).rejects.toThrow();
});
test("PNG dimensions, truncation, declared type and declared size are validated", async () => {
  const root = mkdtempSync(join(tmpdir(), "media-validation-"));
  const png = readFileSync("tests/fixtures/test-image.png");
  const asset = await createDownloader(root, async () => ({
    status: 200,
    headers: {},
    bytes: png,
  }))("https://cdn.example/a", "image");
  expect([asset.width, asset.height]).toEqual([96, 64]);
  for (const response of [
    { status: 200, headers: {}, bytes: png.subarray(0, png.length - 12) },
    { status: 200, headers: { "content-type": "video/mp4" }, bytes: png },
    {
      status: 200,
      headers: { "content-length": String(65 * 1024 * 1024) },
      bytes: png,
    },
    { status: 200, headers: {}, bytes: Buffer.alloc(65 * 1024 * 1024) },
  ])
    await expect(
      createDownloader(root, async () => response)(
        "https://cdn.example/a",
        "image",
      ),
    ).rejects.toThrow();
  expect(
    readdirSync(join(root, "assets")).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
});
test("managed assets directory symlinks never write or serve external files", async () => {
  const root = mkdtempSync(join(tmpdir(), "media-symlink-"));
  const external = mkdtempSync(join(tmpdir(), "media-external-"));
  symlinkSync(external, join(root, "assets"));
  const png = readFileSync("tests/fixtures/test-image.png");
  await expect(
    createDownloader(root, async () => ({
      status: 200,
      headers: {},
      bytes: png,
    }))("https://cdn.example/a", "image"),
  ).rejects.toThrow();
  expect(readdirSync(external)).toEqual([]);
});
test("a symlinked library root cannot create an assets directory outside the library", async () => {
  const holder = mkdtempSync(join(tmpdir(), "media-root-link-")),
    external = mkdtempSync(join(tmpdir(), "media-root-outside-"));
  const root = join(holder, "library");
  symlinkSync(external, root);
  const bytes = readFileSync("tests/fixtures/test-image.png");
  await expect(
    createDownloader(root, async () => ({ status: 200, headers: {}, bytes }))(
      "https://cdn.example/a",
      "image",
    ),
  ).rejects.toThrow();
  expect(existsSync(join(external, "assets"))).toBe(false);
});
