// Real Electron UI + local ffmpeg fixtures; never invokes paid generation.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
const root = await mkdtemp(join(tmpdir(), "media-gen-smoke-"));
await mkdir("artifacts", { recursive: true });
await build({
  entryPoints: ["src/main/storage.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(root, "repository.mjs"),
});
await build({
  entryPoints: ["src/main/media.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: join(root, "media.mjs"),
});
// Avoid external dependency resolution from the temporary directory.
const { Repository } = await import(
  pathToFileURL(join(root, "repository.mjs"))
);
const { createHash, randomUUID } = await import("node:crypto");
const repo = new Repository(root);
const clip = join(root, "fixture.mp4");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360:rate=24",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=44100",
  "-t",
  "2",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-movflags",
  "+faststart",
  "-y",
  clip,
]);
const fixtures = [];
for (const [mode, prompt, file, mime, ext, model, parameters] of [
  [
    "image",
    "TEST FIXTURE IMAGE",
    "tests/fixtures/test-image.png",
    "image/png",
    "png",
    "black-forest-labs/flux-schnell",
    { size: "1024*1024", num_images: 1 },
  ],
  [
    "video",
    "TEST FIXTURE VIDEO",
    clip,
    "video/mp4",
    "mp4",
    "alibaba/wan-2.5/text-to-video-fast",
    { size: "1280*720", duration: 5 },
  ],
]) {
  const bytes = await readFile(file),
    sha256 = createHash("sha256").update(bytes).digest("hex"),
    filename = sha256 + "." + ext;
  await writeFile(join(root, "assets", filename), bytes);
  const job = repo.enqueue(randomUUID(), { mode, model, prompt, parameters });
  const id = randomUUID();
  repo.complete(job.id, [{ id, filename, mime, bytes: bytes.length, sha256 }]);
  fixtures.push({ id, prompt, bytes });
}
const queued = repo.enqueue(randomUUID(), {
  mode: "image",
  model: "black-forest-labs/flux-schnell",
  prompt: "TEST FIXTURE QUEUED",
  parameters: {},
});
const held = repo.enqueue(randomUUID(), {
  mode: "video",
  model: "alibaba/wan-2.5/text-to-video-fast",
  prompt: "TEST FIXTURE TRACKING",
  parameters: {},
});
repo.update(held.id, { state: "running", remoteId: "fixture-held" });
const unsent = repo.enqueue(randomUUID(), {
  mode: "image",
  model: "black-forest-labs/flux-schnell",
  prompt: "TEST FIXTURE UNSENT",
  parameters: {},
});
repo.update(unsent.id, { state: "paused" });
repo.close();
const env = {
  ...process.env,
  MEDIA_GEN_HOME: root,
  ATLASCLOUD_API_KEY: "",
  MEDIA_GEN_CATALOG: "off",
};
const options = {
  args: (process.env.MEDIA_GEN_EXECUTABLE ? [] : ["."]).concat(
    "--user-data-dir=" + join(root, "electron-profile"),
    process.platform === "linux" &&
      process.env.DISPLAY &&
      process.env.MEDIA_GEN_SMOKE_WAYLAND !== "1"
      ? ["--ozone-platform=x11"]
      : [],
  ),
  env,
  timeout: 30000,
  ...(process.env.MEDIA_GEN_EXECUTABLE
    ? { executablePath: resolve(process.env.MEDIA_GEN_EXECUTABLE) }
    : {}),
};
let app;
try {
  app = await electron.launch(options);
  let page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "Media Gen", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Generate image", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Generate image", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  const runtime = await app.evaluate(({ safeStorage }) => ({
    electron: process.versions.electron,
    secureStorageAvailable:
      safeStorage.isEncryptionAvailable() &&
      safeStorage.getSelectedStorageBackend() !== "basic_text",
    storageBackend: safeStorage.getSelectedStorageBackend(),
  }));
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Jobs", exact: false })
    .click();
  const queuedRow = page
    .locator("article")
    .filter({ hasText: "TEST FIXTURE QUEUED" });

  const heldRow = page
    .locator("article")
    .filter({ hasText: "TEST FIXTURE TRACKING" });
  await heldRow.getByRole("button", { name: "Stop tracking" }).click();
  await heldRow.getByText("paused", { exact: true }).waitFor();
  await heldRow.getByRole("button", { name: "Resume tracking" }).click();
  await heldRow.getByRole("button", { name: "Stop tracking" }).click();
  await heldRow.getByText("paused", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Jobs", exact: false })
    .click();
  const unsentRow = page
    .locator("article")
    .filter({ hasText: "TEST FIXTURE UNSENT" });
  await unsentRow
    .getByRole("button", { name: "Resume queued request", exact: true })
    .click();
  await page
    .getByText(
      "Unsubmitted request requeued. Atlas credits are used when it is submitted.",
      { exact: true },
    )
    .waitFor();
  await unsentRow
    .getByRole("button", { name: "Cancel queued", exact: true })
    .click();
  await unsentRow.getByText("cancelled", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Prompt", { exact: true }).fill("draft image");
  const recipesBefore = await page.evaluate(async () =>
    (await window.mediaGen.snapshot()).jobs.map((j) => ({
      id: j.id,
      recipe: j.recipe,
    })),
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Default image model", { exact: true })
    .selectOption("black-forest-labs/flux-dev");
  await page.waitForFunction(
    async () =>
      (await window.mediaGen.snapshot()).modelDefaults.image ===
      "black-forest-labs/flux-dev",
  );
  await page
    .getByLabel("Default video model", { exact: true })
    .selectOption("alibaba/wan-2.5/text-to-video");
  await page.waitForFunction(
    async () =>
      (await window.mediaGen.snapshot()).modelDefaults.video ===
      "alibaba/wan-2.5/text-to-video",
  );
  await page.screenshot({ path: "artifacts/model-settings.png" });
  assert.deepEqual(
    await page.evaluate(async () =>
      (await window.mediaGen.snapshot()).jobs.map((j) => ({
        id: j.id,
        recipe: j.recipe,
      })),
    ),
    recipesBefore,
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Jobs", exact: false })
    .click();
  await queuedRow.getByText("queued", { exact: true }).waitFor();
  await queuedRow.getByRole("button", { name: "Cancel queued" }).click();
  await queuedRow.getByText("cancelled", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .locator(".provider")
    .getByText("FLUX Dev", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Prompt", { exact: true }).inputValue(),
    "draft image",
  );
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await page
    .locator(".provider")
    .getByText("Wan 2.5", { exact: true })
    .waitFor();
  await page.getByLabel("Prompt", { exact: true }).fill("draft video");
  await page.getByLabel("Video size", { exact: true }).selectOption("624*624");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Default video model", { exact: true })
    .selectOption("alibaba/wan-2.5/text-to-video-fast");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .locator(".provider")
    .getByText("Wan 2.5 Fast", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Video size", { exact: true }).inputValue(),
    "1280*720",
  );
  assert.equal(
    await page.getByLabel("Prompt", { exact: true }).inputValue(),
    "draft video",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Default video model", { exact: true })
    .selectOption("alibaba/wan-2.5/text-to-video");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .locator(".provider")
    .getByText("Wan 2.5", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Image", exact: true }).click();
  assert.equal(
    await page.getByLabel("Prompt", { exact: true }).inputValue(),
    "draft image",
  );
  await page
    .getByRole("button", { name: "Open TEST FIXTURE IMAGE", exact: true })
    .first()
    .click();
  await page.waitForFunction(() => {
    const img = document.querySelector(".preview img");
    return img?.complete && img.naturalWidth > 0;
  });
  await page
    .getByRole("button", { name: "Reuse settings", exact: true })
    .click();
  await page
    .locator(".provider")
    .getByText("FLUX Schnell", { exact: true })
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.mediaGen.snapshot())).modelDefaults.image,
    "black-forest-labs/flux-dev",
  );
  const destination = join(root, "export.png");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, destination);
  await page
    .getByRole("button", { name: "Export original", exact: true })
    .click();
  assert.deepEqual(await readFile(destination), fixtures[0].bytes);
  await page
    .getByRole("button", { name: "Open TEST FIXTURE VIDEO", exact: true })
    .first()
    .click();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v?.readyState >= 2;
  });
  await page.evaluate(async () => {
    const v = document.querySelector("video");
    v.muted = true;
    await v.play();
  });
  await page.waitForFunction(
    () => document.querySelector("video").currentTime > 0.1,
  );
  assert.equal(
    await page.evaluate(() => document.querySelector("video").muted),
    true,
  );
  await page.evaluate(() => {
    const v = document.querySelector("video");
    v.pause();
    v.currentTime = 1;
  });
  await page.waitForFunction(
    () => Math.abs(document.querySelector("video").currentTime - 1) < 0.2,
  );
  const videoDestination = join(root, "export.mp4");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, videoDestination);
  await page
    .getByRole("button", { name: "Export original", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("[role=status]")?.textContent.includes("Export"),
  );
  assert.deepEqual(await readFile(videoDestination), fixtures[1].bytes);
  const screenshot = await page.screenshot({
    path: "artifacts/desktop-smoke.png",
  });
  const colorCount = await app.evaluate(({ nativeImage }, base64) => {
    const bitmap = nativeImage
      .createFromBuffer(Buffer.from(base64, "base64"))
      .toBitmap();
    const colors = new Set();
    for (let i = 0; i < bitmap.length; i += 4)
      colors.add(bitmap.readUInt32LE(i));
    return colors.size;
  }, screenshot.toString("base64"));
  assert.ok(
    colorCount > 20,
    `Screenshot has only ${colorCount} colors; compositor capture is invalid`,
  );
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  app = await electron.launch(options);
  await app.evaluate(() => {
    for (const name of ["http", "https"]) {
      const module = process.getBuiltinModule(name);
      module.request = () => {
        throw Error("Networking disabled for offline fixture test");
      };
      module.get = module.request;
    }
    globalThis.fetch = async () => {
      throw Error("Networking disabled for offline fixture test");
    };
  });
  page = await app.firstWindow();
  await page.context().setOffline(true);
  const restored = await page.evaluate(() => window.mediaGen.snapshot());
  assert.deepEqual(restored.modelDefaults, {
    image: "black-forest-labs/flux-dev",
    video: "alibaba/wan-2.5/text-to-video",
  });
  assert.equal(
    restored.jobs.find((j) => j.recipe.prompt === "TEST FIXTURE IMAGE").recipe
      .model,
    "black-forest-labs/flux-schnell",
  );
  await page
    .locator(".provider")
    .getByText("FLUX Dev", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Open TEST FIXTURE IMAGE", exact: true })
    .first()
    .click();
  await page.waitForFunction(() => {
    const img = document.querySelector(".preview img");
    return img?.complete && img.naturalWidth > 0;
  });
  await page
    .getByRole("button", { name: "Open TEST FIXTURE VIDEO", exact: true })
    .first()
    .click();
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  await page.evaluate(async () => {
    const v = document.querySelector("video");
    v.muted = true;
    await v.play();
  });
  await page.waitForFunction(
    () => document.querySelector("video").currentTime > 0.1,
  );
  assert.equal(
    await page.evaluate(() => document.querySelector("video").muted),
    true,
  );
  await page
    .getByRole("button", { name: "Reuse settings", exact: true })
    .click();
  await page
    .locator(".provider")
    .getByText("Wan 2.5 Fast", { exact: true })
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.mediaGen.snapshot())).modelDefaults.video,
    "alibaba/wan-2.5/text-to-video",
  );
  const report = {
    result: "PASS",
    kind: "LOCAL FIXTURES — NOT LIVE GENERATION",
    runtime,
    library: root,
    checks: [
      "real Electron window",
      "sandbox/context isolation",
      "separate drafts",
      "model selectors, recipe reuse and persisted defaults",
      "PNG preview",
      "byte-identical export",
      "MP4 play/seek/mute",
      "offline restart image/video",
    ],
    screenshot: resolve("artifacts/desktop-smoke.png"),
  };
  await writeFile(
    "artifacts/smoke-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}
