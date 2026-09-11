import { z } from "zod";
import type { Control, Mode, Model } from "../shared/types";

// Atlas publishes a public listing and one OpenAPI 3.0 document per model.
// Listing: https://api.atlascloud.ai/api/v1/models (no authentication).
// Schema:  https://static.atlascloud.ai/model/schema/<id-with-dashes>.json
export const LISTING_URL = "https://api.atlascloud.ai/api/v1/models";
export const SCHEMA_URL =
  /^https:\/\/static\.atlascloud\.ai\/model\/schema\/[A-Za-z0-9._-]{1,200}\.json$/;
export const MODEL_ID = /^[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64}){0,4}$/;
const MODES: Record<string, Mode> = {
  "TEXT-TO-IMAGE": "image",
  "TEXT-TO-VIDEO": "video",
};
export interface ListingEntry {
  id: string;
  name: string;
  mode: Mode;
  organization: string;
  description: string;
  price?: string;
  schema: string;
}
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\s+/g, " ").trim().slice(0, max))
    .optional();
const listingItem = z.object({
  model: z.string().regex(MODEL_ID),
  displayName: text(80),
  profile: text(400),
  organization: text(60),
  categories: z.array(z.string()).max(16).optional(),
  schema: z.string().regex(SCHEMA_URL),
  price: z
    .object({
      actual: z
        .object({ base_price: z.string().max(20).optional() })
        .optional(),
    })
    .optional(),
});
export function parseListing(input: unknown): ListingEntry[] {
  const raw = z
    .object({ data: z.array(z.unknown()).max(5000) })
    .parse(Array.isArray(input) ? { data: input } : input).data;
  const entries: ListingEntry[] = [];
  for (const item of raw) {
    const parsed = listingItem.safeParse(item);
    if (!parsed.success) continue;
    const m = parsed.data;
    const modes = (m.categories ?? []).map((c) => MODES[c]).filter(Boolean);
    if (modes.length !== 1 || entries.some((e) => e.id === m.model)) continue;
    const price = m.price?.actual?.base_price;
    entries.push({
      id: m.model,
      name: m.displayName || m.model,
      mode: modes[0],
      organization: m.organization || m.model.split("/")[0],
      description: m.profile ?? "",
      ...(price && /^\d+(\.\d+)?$/.test(price) ? { price } : {}),
      schema: m.schema,
    });
  }
  return entries;
}
const property = z.looseObject({
  type: z.string().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  step: z.number().optional(),
  multipleOf: z.number().optional(),
  title: text(60),
  description: text(240),
  disabled: z.boolean().optional(),
  "x-ui-component": z.string().optional(),
});
const document = z.looseObject({
  components: z.object({
    schemas: z.object({
      Input: z.looseObject({
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()).optional(),
        "x-order-properties": z.array(z.string()).optional(),
      }),
    }),
  }),
});
const scalar = z.union([z.string().max(200), z.number()]);
const MEDIA = /image|audio|video|mask|file|url|lora|reference/i;
// The adapter polls asynchronously and downloads HTTPS URLs, so these must never be user-editable.
const PINNED: Record<string, boolean> = {
  enable_sync_mode: false,
  enable_base64_output: false,
};
export type Parsed = { model: Model } | { unsupported: string };
export function parseSchema(entry: ListingEntry, input: unknown): Parsed {
  const doc = document.safeParse(input);
  if (!doc.success)
    return { unsupported: "Atlas published an unreadable schema." };
  // The endpoint follows the listing category, not the schema's `paths`: several published
  // schemas name the wrong one (e.g. Seedream text-to-image documents generateVideo).
  const Input = doc.data.components.schemas.Input;
  const required = new Set(Input.required ?? []);
  const keys = [
    ...(Input["x-order-properties"] ?? []),
    ...Object.keys(Input.properties),
  ].filter((k, i, all) => k in Input.properties && all.indexOf(k) === i);
  const fixed: Model["fixedParameters"] = {};
  const controls: Control[] = [];
  for (const key of keys) {
    if (key === "model" || key === "prompt") continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key))
      return {
        unsupported: "This model uses a parameter name the app cannot send.",
      };
    const p = property.safeParse(Input.properties[key]);
    if (!p.success)
      return { unsupported: "Atlas published an unreadable schema." };
    const result = classify(key, p.data);
    if (result === "omit") {
      if (required.has(key))
        return {
          unsupported: `Requires "${key}", an input this app cannot provide.`,
        };
      continue;
    }
    if ("fixed" in result) fixed[key] = result.fixed;
    else controls.push(result);
    if (controls.length > 32 || Object.keys(fixed).length > 64)
      return {
        unsupported: "This model exposes more settings than the app supports.",
      };
  }
  return {
    model: {
      id: entry.id,
      name: entry.name,
      mode: entry.mode,
      source: entry.schema,
      fixedParameters: fixed,
      controls,
      organization: entry.organization,
      description: entry.description,
      ...(entry.price ? { price: entry.price } : {}),
    },
  };
}
type Property = z.infer<typeof property>;
function classify(
  key: string,
  p: Property,
): Control | { fixed: string | number | boolean } | "omit" {
  const fixedDefault =
    typeof p.default === "string" ||
    typeof p.default === "number" ||
    typeof p.default === "boolean"
      ? { fixed: p.default as string | number | boolean }
      : "omit";
  if (key in PINNED) return { fixed: PINNED[key] };
  if (p.disabled) return fixedDefault;
  const base = {
    key,
    label:
      p.title || key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    ...(p.description ? { description: p.description } : {}),
  };
  const options = p.enum?.filter(
    (v): v is string | number => scalar.safeParse(v).success,
  );
  if (options?.length && options.length <= 64) {
    const fallback = scalar.safeParse(p.default);
    return {
      ...base,
      kind: "select",
      options,
      default:
        fallback.success && options.includes(fallback.data)
          ? fallback.data
          : options[0],
    };
  }
  if (p.type === "boolean")
    return { ...base, kind: "toggle", default: p.default === true };
  if (p.type === "integer" || p.type === "number") {
    const { minimum: min, maximum: max } = p;
    if (
      min !== undefined &&
      max !== undefined &&
      Number.isFinite(min) &&
      Number.isFinite(max) &&
      min < max
    ) {
      const integer = p.type === "integer";
      const step = p.step ?? p.multipleOf;
      const preferred = typeof p.default === "number" ? p.default : min;
      return {
        ...base,
        kind: "number",
        min,
        max,
        ...(step && step > 0 ? { step } : {}),
        integer,
        default: Math.min(max, Math.max(min, preferred)),
      };
    }
    return typeof p.default === "number" ? { fixed: p.default } : "omit";
  }
  if (p.type === "string") {
    if (/upload/i.test(p["x-ui-component"] ?? "") || MEDIA.test(key))
      return "omit";
    if (typeof p.default === "string" && p.default !== "")
      return { fixed: p.default };
    return { ...base, kind: "text", default: "", maxLength: 2000 };
  }
  return "omit";
}
