import { test, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseListing, parseSchema, LISTING_URL } from "../src/main/schema";
import { Catalog } from "../src/main/catalog";
import { Preferences } from "../src/main/preferences";
import { createCatalogFetch, type Exchange } from "../src/main/network";
import { models, validateRecipe, AtlasProvider } from "../src/main/atlas";
// Schemas here are copies of Atlas's published documents or synthetic fixtures; no live requests.
const wanFast = JSON.parse(
  readFileSync(join(__dirname, "fixtures/atlas-schema-wan-fast.json"), "utf8"),
);
const fluxDev = JSON.parse(
  readFileSync(join(__dirname, "fixtures/atlas-schema-flux-dev.json"), "utf8"),
);
const schemaUrl = (id: string) =>
  "https://static.atlascloud.ai/model/schema/" +
  id.replace(/\//g, "-") +
  ".json";
const row = (
  model: string,
  categories: string[],
  extra: Record<string, unknown> = {},
) => ({
  model,
  displayName: model.split("/").pop(),
  type: "Image",
  profile: "  Fixture   profile ",
  organization: "FIXTURE",
  categories,
  schema: schemaUrl(model),
  price: { actual: { base_price: "0.01" } },
  ...extra,
});
const listing = {
  code: 200,
  data: [
    row("fixture/t2i", ["TEXT-TO-IMAGE"]),
    row("fixture/t2v", ["TEXT-TO-VIDEO"], { price: { actual: {} } }),
    row("fixture/i2v", ["IMAGE-TO-VIDEO"]),
    row("fixture/llm", ["LLM"]),
    row("fixture/both", ["TEXT-TO-IMAGE", "TEXT-TO-VIDEO"]),
    row("fixture/t2i", ["TEXT-TO-IMAGE"]),
    row("bad host", ["TEXT-TO-IMAGE"], {
      schema: "https://evil.example/x.json",
    }),
    row("fixture/bad-price", ["TEXT-TO-IMAGE"], {
      price: { actual: { base_price: "free!" } },
    }),
    "not an object",
  ],
};
function input(properties: Record<string, unknown>, required: string[] = []) {
  return {
    openapi: "3.0.0",
    paths: { "/api/v1/model/generateImage": {} },
    components: {
      schemas: {
        Input: {
          type: "object",
          required: ["model", "prompt", ...required],
          properties: {
            model: { type: "string", default: "fixture/t2i" },
            prompt: { type: "string" },
            ...properties,
          },
        },
      },
    },
  };
}
const entry = parseListing(listing)[0];
test("listing keeps only text-to-image/video rows and sanitizes fields", () => {
  const entries = parseListing(listing);
  expect(entries.map((e) => e.id)).toEqual([
    "fixture/t2i",
    "fixture/t2v",
    "fixture/bad-price",
  ]);
  expect(entries[0]).toMatchObject({
    mode: "image",
    name: "t2i",
    organization: "FIXTURE",
    description: "Fixture profile",
    price: "0.01",
  });
  expect(entries[1]).not.toHaveProperty("price");
  expect(entries[2]).not.toHaveProperty("price");
  expect(() => parseListing({ data: "nope" })).toThrow();
});
test("published Wan Fast and FLUX Dev schemas parse into usable controls", () => {
  const wan = parseSchema(
    { ...entry, id: "alibaba/wan-2.5/text-to-video-fast", mode: "video" },
    wanFast,
  );
  if (!("model" in wan)) throw Error(wan.unsupported);
  expect(wan.model.controls.map((c) => [c.key, c.kind])).toEqual([
    ["negative_prompt", "text"],
    ["size", "select"],
    ["duration", "select"],
    ["enable_prompt_expansion", "toggle"],
  ]);
  expect(wan.model.fixedParameters).toEqual({ seed: -1 });
  expect(wan.model.controls[1]).toMatchObject({
    options: ["1280*720", "720*1280", "1920*1080", "1080*1920"],
    default: "1280*720",
  });
  const flux = parseSchema(
    { ...entry, id: "black-forest-labs/flux-dev" },
    fluxDev,
  );
  if (!("model" in flux)) throw Error(flux.unsupported);
  // Reference-image inputs are omitted; disabled flags stay fixed at their defaults.
  const keys = flux.model.controls.map((c) => c.key);
  for (const key of ["image", "mask_image", "enable_base64_output"])
    expect(keys).not.toContain(key);
  expect(flux.model.fixedParameters).toMatchObject({
    seed: -1,
    size: "1024*1024",
    enable_base64_output: false,
    enable_safety_checker: true,
  });
  expect(flux.model.controls.find((c) => c.key === "num_images")).toMatchObject(
    { kind: "number", min: 1, max: 4, integer: true, default: 1 },
  );
});
test("schema edge cases: enums, ranges, unbounded numbers, media inputs, unknown types", () => {
  const parsed = parseSchema(
    entry,
    input({
      quality: { type: "string", enum: ["low", "high"], default: "medium" },
      steps: { type: "integer", minimum: 1, maximum: 50, default: 99 },
      cfg: { type: "number", minimum: 0, maximum: 1, step: 0.05, default: 0.5 },
      seed: { type: "integer", default: -1 },
      unbounded: { type: "number", minimum: 1 },
      audio: { type: "string", description: "Audio URL" },
      loras: { type: "array", items: { type: "object" } },
      style: { type: "string", title: "Art style" },
      watermark: { type: "boolean" },
      locked: { type: "boolean", default: true, disabled: true },
      weird: { type: "object" },
      picker: { type: "string", "x-ui-component": "uploader" },
    }),
  );
  if (!("model" in parsed)) throw Error(parsed.unsupported);
  expect(parsed.model.controls).toEqual([
    {
      key: "quality",
      label: "Quality",
      kind: "select",
      options: ["low", "high"],
      default: "low",
    },
    {
      key: "steps",
      label: "Steps",
      kind: "number",
      min: 1,
      max: 50,
      integer: true,
      default: 50,
    },
    {
      key: "cfg",
      label: "Cfg",
      kind: "number",
      min: 0,
      max: 1,
      step: 0.05,
      integer: false,
      default: 0.5,
    },
    {
      key: "style",
      label: "Art style",
      kind: "text",
      default: "",
      maxLength: 2000,
    },
    { key: "watermark", label: "Watermark", kind: "toggle", default: false },
  ]);
  expect(parsed.model.fixedParameters).toEqual({ seed: -1, locked: true });
  expect(
    parseSchema(entry, input({ video: { type: "string" } }, ["video"])),
  ).toEqual({
    unsupported: 'Requires "video", an input this app cannot provide.',
  });
  expect(parseSchema(entry, { paths: {} })).toHaveProperty("unsupported");
  expect(
    parseSchema(entry, input({ "bad key!": { type: "string" } })),
  ).toHaveProperty("unsupported");
});
test("schema-derived controls validate, clamp nothing, and omit empty optional text", () => {
  const parsed = parseSchema(
    entry,
    input({
      negative_prompt: { type: "string" },
      steps: { type: "integer", minimum: 1, maximum: 8, default: 4 },
      generate_audio: { type: "boolean", default: true },
      seed: { type: "integer", default: -1 },
    }),
  );
  if (!("model" in parsed)) throw Error(parsed.unsupported);
  const catalog = {
    find: () => parsed.model,
    models: () => [parsed.model],
  };
  const base = { mode: "image", model: "fixture/t2i", prompt: "FIXTURE" };
  expect(
    validateRecipe({ ...base, parameters: { negative_prompt: "" } }, catalog)
      .parameters,
  ).toEqual({ seed: -1, steps: 4, generate_audio: true });
  expect(
    validateRecipe(
      {
        ...base,
        parameters: {
          steps: 8,
          generate_audio: false,
          negative_prompt: "blurry",
        },
      },
      catalog,
    ).parameters,
  ).toEqual({
    seed: -1,
    steps: 8,
    generate_audio: false,
    negative_prompt: "blurry",
  });
  for (const parameters of [
    { steps: 9 },
    { steps: 2.5 },
    { steps: "4" },
    { generate_audio: "yes" },
    { negative_prompt: "x".repeat(2001) },
    { seed: 7 },
    { unknown: 1 },
  ])
    expect(() => validateRecipe({ ...base, parameters }, catalog)).toThrow();
});
test("catalog refresh caches the listing, resolves schemas once, and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-"));
  const fetch = vi.fn(async (url: string) => {
    if (url === LISTING_URL) return listing;
    if (url === schemaUrl("fixture/t2i"))
      return input({
        steps: { type: "integer", minimum: 1, maximum: 4, default: 2 },
      });
    if (url === schemaUrl("fixture/t2v"))
      return input({ video: { type: "string" } }, ["video"]);
    throw Error("unexpected " + url);
  });
  const catalog = new Catalog(root, fetch, models);
  expect(catalog.stale()).toBe(true);
  expect(catalog.entries().map((e) => e.id)).toEqual(
    models.map((m) => m.id).sort(),
  );
  await Promise.all([catalog.refresh(), catalog.refresh()]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(catalog.stale()).toBe(false);
  const rows = catalog.entries();
  expect(rows.filter((e) => e.organization === "FIXTURE")).toHaveLength(3);
  expect(rows.find((e) => e.id === "fixture/t2i")).toMatchObject({
    ready: false,
  });
  expect(rows.find((e) => e.id === models[0].id)).toMatchObject({
    ready: true,
  });
  await expect(catalog.resolve("video", "fixture/t2i")).rejects.toThrow(
    "Unknown model",
  );
  const resolved = await catalog.resolve("image", "fixture/t2i");
  expect(resolved.controls[0]).toMatchObject({ key: "steps", default: 2 });
  await catalog.resolve("image", "fixture/t2i");
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(catalog.resolve("video", "fixture/t2v")).rejects.toThrow(
    "Requires",
  );
  await expect(catalog.resolve("video", "fixture/t2v")).rejects.toThrow(
    "Requires",
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(catalog.entries().find((e) => e.id === "fixture/t2v")).toMatchObject({
    ready: false,
    unsupported: expect.stringContaining("video"),
  });
  // Built-in definitions win over the live listing for their own IDs.
  expect(catalog.find("image", models[0].id)).toEqual(models[0]);
  // Mutating a returned definition never changes the cache.
  resolved.controls.length = 0;
  expect(catalog.find("image", "fixture/t2i")!.controls).toHaveLength(1);
  const offline = new Catalog(root, undefined, models);
  expect(offline.online).toBe(false);
  expect(offline.stale()).toBe(false);
  expect(offline.find("image", "fixture/t2i")).toEqual(
    catalog.find("image", "fixture/t2i"),
  );
  expect(offline.models().map((m) => m.id)).toContain("fixture/t2i");
  await expect(offline.refresh()).rejects.toThrow();
  const prefs = new Preferences(root, offline);
  prefs.save("image", "fixture/t2i");
  expect(() => prefs.save("image", "fixture/t2v")).toThrow();
  expect(new Preferences(root, offline).defaults().image).toBe("fixture/t2i");
  const transport = vi.fn().mockResolvedValue({ id: "fixture-id" });
  await new AtlasProvider(transport, offline).submit(
    { mode: "image", model: "fixture/t2i", prompt: "FIXTURE", parameters: {} },
    "key",
  );
  expect(transport.mock.calls[0][2]).toEqual({
    model: "fixture/t2i",
    prompt: "FIXTURE",
    steps: 2,
  });
});
test("corrupt cache and failed refresh leave the built-in list intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-bad-"));
  writeFileSync(join(root, "catalog.json"), '{"version":1,"entries":"x"}');
  const fetch = vi.fn(async () => ({ data: [] }));
  const catalog = new Catalog(root, fetch, models);
  expect(catalog.entries()).toHaveLength(models.length);
  await expect(catalog.refresh()).rejects.toThrow("empty");
  expect(catalog.updated()).toBeUndefined();
  expect(readFileSync(join(root, "catalog.json"), "utf8")).toContain('"x"');
  fetch.mockRejectedValueOnce(Error("offline"));
  await expect(catalog.refresh()).rejects.toThrow("offline");
  expect(catalog.refreshing).toBe(false);
});
test("catalog fetch only reaches Atlas catalog URLs and never sends the API key", async () => {
  const exchange = vi.fn<Exchange>(async () => ({
    status: 200,
    headers: {},
    bytes: Buffer.from('{"data":[]}'),
  }));
  const fetch = createCatalogFetch(exchange);
  expect(await fetch(LISTING_URL)).toEqual({ data: [] });
  expect(await fetch(schemaUrl("a/b"))).toEqual({ data: [] });
  expect(exchange.mock.calls[0][1]).toMatchObject({ method: "GET" });
  expect(exchange.mock.calls[0][1].maxBytes).toBeGreaterThan(4 * 1024 * 1024);
  expect(JSON.stringify(exchange.mock.calls)).not.toMatch(/Authorization/);
  for (const url of [
    "https://api.atlascloud.ai/api/v1/model/generateImage",
    "http://api.atlascloud.ai/api/v1/models",
    "https://static.atlascloud.ai/model/schema/../x.json",
    "https://static.atlascloud.ai/model/readme/a.md",
  ])
    await expect(fetch(url)).rejects.toThrow("Invalid catalog URL");
  exchange.mockResolvedValueOnce({
    status: 503,
    headers: {},
    bytes: Buffer.alloc(0),
  });
  await expect(fetch(LISTING_URL)).rejects.toThrow("unavailable");
  exchange.mockResolvedValueOnce({
    status: 200,
    headers: {},
    bytes: Buffer.from("<html>"),
  });
  await expect(fetch(LISTING_URL)).rejects.toThrow("unreadable");
});
