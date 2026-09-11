import type { Mode, Model, Provider, Recipe } from "../shared/types";
import { z } from "zod";

export const models: Model[] = [
  {
    id: "black-forest-labs/flux-schnell",
    name: "FLUX Schnell",
    mode: "image",
    fixedParameters: {
      seed: -1,
      enable_sync_mode: false,
      enable_base64_output: false,
      enable_safety_checker: true,
    },
    source:
      "https://www.atlascloud.ai/models/black-forest-labs/flux-schnell/llms.txt",
    controls: [
      {
        kind: "select",
        key: "size",
        label: "Image size",
        options: ["1024*1024"],
        default: "1024*1024",
      },
      {
        kind: "select",
        key: "num_images",
        label: "Images",
        options: [1, 2, 3, 4],
        default: 1,
      },
    ],
  },
  {
    id: "alibaba/wan-2.5/text-to-video-fast",
    name: "Wan 2.5 Fast",
    mode: "video",
    fixedParameters: { seed: -1, enable_prompt_expansion: false },
    source:
      "https://www.atlascloud.ai/models/alibaba/wan-2.5/text-to-video-fast/llms.txt",
    controls: [
      {
        kind: "select",
        key: "size",
        label: "Video size",
        options: ["1280*720", "720*1280", "1920*1080", "1080*1920"],
        default: "1280*720",
      },
      {
        kind: "select",
        key: "duration",
        label: "Duration (seconds)",
        options: [5, 10],
        default: 5,
      },
    ],
  },
  {
    id: "black-forest-labs/flux-dev",
    name: "FLUX Dev",
    mode: "image",
    source:
      "https://www.atlascloud.ai/models/black-forest-labs/flux-dev/llms.txt",
    fixedParameters: {
      seed: -1,
      enable_base64_output: false,
      enable_safety_checker: true,
      num_inference_steps: 28,
      guidance_scale: 3.5,
    },
    controls: [
      {
        kind: "select",
        key: "size",
        label: "Image size",
        options: ["1024*1024"],
        default: "1024*1024",
      },
      {
        kind: "select",
        key: "num_images",
        label: "Images",
        options: [1, 2, 3, 4],
        default: 1,
      },
    ],
  },
  {
    id: "alibaba/wan-2.5/text-to-video",
    name: "Wan 2.5",
    mode: "video",
    source:
      "https://www.atlascloud.ai/models/alibaba/wan-2.5/text-to-video/llms.txt",
    fixedParameters: {
      seed: -1,
      enable_prompt_expansion: false,
      generate_audio: true,
    },
    controls: [
      {
        kind: "select",
        key: "size",
        label: "Video size",
        options: [
          "832*480",
          "480*832",
          "624*624",
          "1280*720",
          "720*1280",
          "960*960",
          "1088*832",
          "832*1088",
          "1920*1080",
          "1080*1920",
          "1440*1440",
          "1632*1248",
          "1248*1632",
        ],
        default: "1920*1080",
      },
      {
        kind: "select",
        key: "duration",
        label: "Duration (seconds)",
        options: [5, 10],
        default: 5,
      },
    ],
  },
];
const schema = z
  .object({
    mode: z.enum(["image", "video"]),
    model: z.string(),
    prompt: z.string().trim().min(1).max(10000),
    parameters: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  })
  .strict();
// Curated built-in definitions take precedence over live schema parses of the same ID.
export interface ModelLookup {
  find(mode: Mode, id: string): Model | undefined;
  models(): Model[];
}
export function staticCatalog(list: Model[]): ModelLookup {
  return {
    find: (mode, id) => list.find((m) => m.mode === mode && m.id === id),
    models: () => [...list],
  };
}
export function validateRecipe(input: unknown, catalog: ModelLookup): Recipe {
  const recipe = schema.parse(input);
  const model = catalog.find(recipe.mode, recipe.model);
  if (!model) throw Error("Unsupported model");
  const fixed = model.fixedParameters;
  if (
    Object.keys(recipe.parameters).some(
      (key) =>
        !model.controls.some((c) => c.key === key) &&
        (!(key in fixed) || recipe.parameters[key] !== fixed[key]),
    )
  )
    throw Error("Unsupported model setting");
  const parameters: Recipe["parameters"] = { ...fixed };
  for (const control of model.controls) {
    const value = recipe.parameters[control.key] ?? control.default;
    if (!acceptable(control, value)) throw Error("Unsupported model setting");
    // Optional free text is omitted when empty rather than sent as "".
    if (control.kind === "text" && value === "") continue;
    parameters[control.key] = value;
  }
  return { ...recipe, parameters };
}
function acceptable(control: Model["controls"][number], value: unknown) {
  switch (control.kind) {
    case "select":
      return control.options.includes(value as string | number);
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= control.min &&
        value <= control.max &&
        (!control.integer || Number.isInteger(value))
      );
    case "toggle":
      return typeof value === "boolean";
    case "text":
      return typeof value === "string" && value.length <= control.maxLength;
  }
}
export type Transport = (
  path: string,
  key: string,
  body?: unknown,
) => Promise<unknown>;
function envelope(input: unknown): Record<string, unknown> {
  const body = z.record(z.string(), z.unknown()).parse(input);
  if (body.code !== undefined && body.code !== 200)
    throw Error("Provider rejected request");
  return z
    .record(z.string(), z.unknown())
    .parse(body.data === undefined ? body : body.data);
}
export class AtlasProvider implements Provider {
  constructor(
    private transport: Transport,
    private catalog: ModelLookup,
  ) {}
  async submit(input: Recipe, key: string): Promise<string> {
    const r = validateRecipe(input, this.catalog);
    const payload = { model: r.model, prompt: r.prompt, ...r.parameters };
    const data = envelope(
      await this.transport(
        r.mode === "image" ? "/generateImage" : "/generateVideo",
        key,
        payload,
      ),
    );
    return z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .parse(data.id);
  }
  async poll(id: string, key: string): ReturnType<Provider["poll"]> {
    const data = envelope(
      await this.transport("/prediction/" + encodeURIComponent(id), key),
    );
    if (data.status === "completed" || data.status === "succeeded")
      return {
        state: "ready",
        outputs: z
          .array(z.string().url().startsWith("https://"))
          .min(1)
          .max(4)
          .parse(data.outputs ?? data.output),
      };
    if (data.status === "failed" || data.status === "timeout")
      return { state: "failed" };
    if (["created", "queued", "processing"].includes(String(data.status)))
      return { state: "running" };
    throw Error("Unrecognized provider status");
  }
}
