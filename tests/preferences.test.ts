import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Preferences } from "../src/main/preferences";
import { models, staticCatalog } from "../src/main/atlas";
const catalog = staticCatalog(models);
test("corrupt or retired preferences fall back without altering the file", () => {
  const root = mkdtempSync(join(tmpdir(), "model-invalid-")),
    file = join(root, "preferences.json");
  writeFileSync(file, "not JSON");
  expect(new Preferences(root, catalog).defaults().image).toBe(models[0].id);
  expect(readFileSync(file, "utf8")).toBe("not JSON");
  writeFileSync(
    file,
    JSON.stringify({
      image: "retired",
      video: "alibaba/wan-2.5/text-to-video",
    }),
  );
  expect(new Preferences(root, catalog).defaults()).toEqual({
    image: models[0].id,
    video: "alibaba/wan-2.5/text-to-video",
  });
});
test("unsafe preference target is never followed and failed save preserves selection", () => {
  const root = mkdtempSync(join(tmpdir(), "model-symlink-")),
    outside = join(root, "outside");
  writeFileSync(outside, "original");
  symlinkSync(outside, join(root, "preferences.json"));
  const p = new Preferences(root, catalog);
  expect(() => p.save("image", "black-forest-labs/flux-dev")).toThrow();
  expect(p.defaults().image).toBe(models[0].id);
  expect(readFileSync(outside, "utf8")).toBe("original");
});
test("model defaults save independently, validate mode/id and survive restart", () => {
  const root = mkdtempSync(join(tmpdir(), "model-prefs-"));
  const p = new Preferences(root, catalog);
  expect(p.defaults()).toEqual({ image: models[0].id, video: models[1].id });
  p.save("image", "black-forest-labs/flux-dev");
  expect(() => p.save("video", "black-forest-labs/flux-dev")).toThrow();
  expect(() => p.save("image", "invented")).toThrow();
  expect(() => p.save("bad", "invented")).toThrow();
  expect(new Preferences(root, catalog).defaults()).toEqual({
    image: "black-forest-labs/flux-dev",
    video: models[1].id,
  });
  const copy = p.defaults();
  copy.image = "mutated";
  expect(p.defaults().image).toBe("black-forest-labs/flux-dev");
});
