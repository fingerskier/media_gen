import { test, expect, vi } from "vitest";
import {
  AtlasProvider,
  validateRecipe,
  models,
  staticCatalog,
} from "../src/main/atlas";
const catalog = staticCatalog(models);
// Documented-response fixtures, NOT a live API test.
test.each([
  [
    "image",
    "black-forest-labs/flux-dev",
    {
      num_inference_steps: 28,
      guidance_scale: 3.5,
      enable_safety_checker: true,
    },
  ],
  [
    "video",
    "alibaba/wan-2.5/text-to-video",
    { generate_audio: true, enable_prompt_expansion: false },
  ],
])(
  "selectable %s model submits only its documented defaults",
  async (mode, model, fixed) => {
    const transport = vi.fn().mockResolvedValue({ id: "fixture" });
    const recipe = validateRecipe(
      {
        mode,
        model,
        prompt: "FIXTURE",
        parameters: {},
      },
      catalog,
    );
    await new AtlasProvider(transport, catalog).submit(recipe, "fixture-key");
    expect(transport.mock.calls[0][2]).toMatchObject({ model, ...fixed });
    expect(recipe.parameters).not.toHaveProperty("enable_sync_mode");
    expect(() =>
      validateRecipe(
        {
          ...recipe,
          parameters: { ...recipe.parameters, enable_sync_mode: false },
        },
        catalog,
      ),
    ).toThrow();
  },
);
test("alternate documented envelopes normalize but undocumented status/output/settings fail closed", async () => {
  const p = new AtlasProvider(
    vi
      .fn()
      .mockResolvedValueOnce({ id: "bare-id", status: "queued" })
      .mockResolvedValueOnce({
        id: "bare-id",
        status: "succeeded",
        output: ["https://cdn.example/a.png"],
      })
      .mockResolvedValueOnce({ data: { status: "made-up" } })
      .mockResolvedValueOnce({
        data: {
          status: "completed",
          outputs: [{ url: "https://cdn.example/a" }],
        },
      }),
    catalog,
  );
  const recipe = {
    mode: "video" as const,
    model: models[1].id,
    prompt: "TEST FIXTURE",
    parameters: { size: "1280*720", duration: 5 },
  };
  expect(await p.submit(recipe, "test")).toBe("bare-id");
  expect(await p.poll("bare-id", "test")).toEqual({
    state: "ready",
    outputs: ["https://cdn.example/a.png"],
  });
  await expect(p.poll("bare-id", "test")).rejects.toThrow();
  await expect(p.poll("bare-id", "test")).rejects.toThrow();
  expect(() =>
    validateRecipe(
      {
        ...recipe,
        parameters: { ...recipe.parameters, fps: 99 },
      },
      catalog,
    ),
  ).toThrow();
  expect(() =>
    validateRecipe({ ...recipe, parameters: { duration: 7 } }, catalog),
  ).toThrow();
});
test("documented Flux request and completed poll produce a remote id and output URLs", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce({
      code: 200,
      data: { id: "test-prediction", status: "processing" },
    })
    .mockResolvedValueOnce({
      data: {
        id: "test-prediction",
        status: "completed",
        outputs: ["https://cdn.example/image.png"],
      },
    });
  const provider = new AtlasProvider(transport, catalog);
  const recipe = validateRecipe(
    {
      mode: "image",
      model: models[0].id,
      prompt: "TEST FIXTURE",
      parameters: { size: "1024*1024", num_images: 1 },
    },
    catalog,
  );
  expect(recipe.parameters).toMatchObject({
    seed: -1,
    enable_sync_mode: false,
    enable_base64_output: false,
    enable_safety_checker: true,
  });
  expect(await provider.submit(recipe, "test-secret")).toBe("test-prediction");
  expect(transport.mock.calls[0][0]).toBe("/generateImage");
  expect(transport.mock.calls[0][2]).toMatchObject({
    model: "black-forest-labs/flux-schnell",
    size: "1024*1024",
    num_images: 1,
    enable_sync_mode: false,
    enable_base64_output: false,
    enable_safety_checker: true,
  });
  expect(await provider.poll("test-prediction", "test-secret")).toEqual({
    state: "ready",
    outputs: ["https://cdn.example/image.png"],
  });
});
