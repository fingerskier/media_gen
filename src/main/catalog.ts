import {
  lstatSync,
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CatalogEntry, Mode, Model } from "../shared/types";
import type { ModelLookup } from "./atlas";
import {
  LISTING_URL,
  MODEL_ID,
  SCHEMA_URL,
  parseListing,
  parseSchema,
  type ListingEntry,
} from "./schema";

export type CatalogFetch = (url: string) => Promise<unknown>;
const STALE_AFTER = 24 * 60 * 60 * 1000;
const control = z.intersection(
  z.object({
    key: z.string(),
    label: z.string(),
    description: z.string().optional(),
  }),
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("select"),
      options: z.array(z.union([z.string(), z.number()])),
      default: z.union([z.string(), z.number()]),
    }),
    z.object({
      kind: z.literal("number"),
      min: z.number(),
      max: z.number(),
      step: z.number().optional(),
      integer: z.boolean(),
      default: z.number(),
    }),
    z.object({ kind: z.literal("toggle"), default: z.boolean() }),
    z.object({
      kind: z.literal("text"),
      default: z.string(),
      maxLength: z.number(),
    }),
  ]),
);
const mode = z.enum(["image", "video"]);
const model = z.object({
  id: z.string().regex(MODEL_ID),
  name: z.string(),
  mode,
  source: z.string().regex(SCHEMA_URL),
  fixedParameters: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
  controls: z.array(control),
  organization: z.string().optional(),
  description: z.string().optional(),
  price: z.string().optional(),
});
const file = z
  .object({
    version: z.literal(1),
    updated: z.number().optional(),
    entries: z.array(
      z.object({
        id: z.string().regex(MODEL_ID),
        name: z.string(),
        mode,
        organization: z.string(),
        description: z.string(),
        price: z.string().optional(),
        schema: z.string().regex(SCHEMA_URL),
      }),
    ),
    models: z.record(z.string(), model),
    unsupported: z.record(z.string(), z.string()),
  })
  .strict();
type CacheFile = z.infer<typeof file>;
// Live Atlas model listing plus locally resolved schema-derived definitions.
// Built-in curated models always win for their own IDs and keep the app usable offline.
export class Catalog implements ModelLookup {
  private cache: CacheFile = {
    version: 1,
    entries: [],
    models: {},
    unsupported: {},
  };
  private file: string;
  private inflight?: Promise<void>;
  constructor(
    root: string,
    private fetch: CatalogFetch | undefined,
    private builtin: Model[],
  ) {
    this.file = join(root, "catalog.json");
    try {
      this.checkFile();
      this.cache = file.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      /* A missing or corrupt catalog cache only means the built-in list is shown. */
    }
  }
  private checkFile() {
    const stat = lstatSync(this.file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.size > 4 * 1024 * 1024))
      throw Error("Unsafe catalog file");
  }
  get online() {
    return Boolean(this.fetch);
  }
  get refreshing() {
    return Boolean(this.inflight);
  }
  updated(): number | undefined {
    return this.cache.updated;
  }
  stale() {
    return (
      this.online &&
      (!this.cache.updated || Date.now() - this.cache.updated > STALE_AFTER)
    );
  }
  find(mode: Mode, id: string): Model | undefined {
    const cached = this.cache.models[id];
    return (
      this.builtin.find((m) => m.mode === mode && m.id === id) ??
      (cached?.mode === mode ? structuredClone(cached) : undefined)
    );
  }
  models(): Model[] {
    return [
      ...this.builtin,
      ...Object.values(this.cache.models)
        .filter((m) => !this.builtin.some((b) => b.id === m.id))
        .map((m) => structuredClone(m)),
    ];
  }
  entries(): CatalogEntry[] {
    const rows = new Map<string, CatalogEntry>();
    const add = (e: Omit<CatalogEntry, "ready" | "unsupported">) => {
      if (rows.has(e.id)) return;
      const unsupported = this.cache.unsupported[e.id];
      rows.set(e.id, {
        ...e,
        ready: Boolean(this.find(e.mode, e.id)),
        ...(unsupported ? { unsupported } : {}),
      });
    };
    for (const { schema, ...e } of this.cache.entries) add(e);
    for (const m of this.models())
      add({
        id: m.id,
        name: m.name,
        mode: m.mode,
        organization: m.organization ?? m.id.split("/")[0],
        description: m.description ?? "",
        ...(m.price ? { price: m.price } : {}),
      });
    return [...rows.values()].sort(
      (a, b) =>
        a.organization.localeCompare(b.organization) ||
        a.name.localeCompare(b.name),
    );
  }
  // Fetches the public listing. Never throws away resolved definitions: queued jobs may use them.
  refresh(): Promise<void> {
    if (!this.fetch) return Promise.reject(Error("Catalog refresh disabled"));
    if (!this.inflight)
      this.inflight = (async () => {
        const entries = parseListing(await this.fetch!(LISTING_URL));
        if (!entries.length) throw Error("Atlas listing was empty");
        this.write({ ...this.cache, updated: Date.now(), entries });
      })().finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
  async resolve(mode: Mode, id: string): Promise<Model> {
    const known = this.find(mode, id);
    if (known) return known;
    const entry = this.cache.entries.find(
      (e) => e.id === id && e.mode === mode,
    );
    if (!entry) throw Error("Unknown model");
    if (this.cache.unsupported[id]) throw Error(this.cache.unsupported[id]);
    if (!this.fetch) throw Error("Catalog refresh disabled");
    const parsed = parseSchema(
      entry as ListingEntry,
      await this.fetch(entry.schema),
    );
    if ("unsupported" in parsed) {
      this.write({
        ...this.cache,
        unsupported: { ...this.cache.unsupported, [id]: parsed.unsupported },
      });
      throw Error(parsed.unsupported);
    }
    const { [id]: _dropped, ...unsupported } = this.cache.unsupported;
    this.write({
      ...this.cache,
      unsupported,
      models: { ...this.cache.models, [id]: parsed.model },
    });
    return structuredClone(parsed.model);
  }
  private write(next: CacheFile) {
    this.checkFile();
    const temp = this.file + "." + randomUUID() + ".tmp";
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(next));
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.file);
      this.cache = next;
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
}
