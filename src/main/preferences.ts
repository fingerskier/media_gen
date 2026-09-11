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
import type { Mode } from "../shared/types";
import type { ModelLookup } from "./atlas";

export class Preferences {
  private value: Record<Mode, string>;
  private file: string;
  constructor(
    root: string,
    private catalog: ModelLookup,
  ) {
    this.file = join(root, "preferences.json");
    const models = catalog.models();
    this.value = {
      image: models.find((m) => m.mode === "image")!.id,
      video: models.find((m) => m.mode === "video")!.id,
    };
    try {
      this.checkFile();
      const saved = z
        .object({ image: z.string(), video: z.string() })
        .strict()
        .parse(JSON.parse(readFileSync(this.file, "utf8")));
      for (const mode of ["image", "video"] as const) {
        if (catalog.find(mode, saved[mode])) this.value[mode] = saved[mode];
      }
    } catch {
      /* A missing, obsolete or corrupt preference cannot prevent library access. */
    }
  }
  private checkFile() {
    const stat = lstatSync(this.file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.size > 65536))
      throw Error("Unsafe preferences file");
  }
  defaults(): Record<Mode, string> {
    return { ...this.value };
  }
  save(inputMode: unknown, inputId: unknown) {
    const mode = z.enum(["image", "video"]).parse(inputMode),
      id = z.string().parse(inputId);
    if (!this.catalog.find(mode, id))
      throw Error("Unsupported model preference");
    this.checkFile();
    const next = { ...this.value, [mode]: id },
      temp = this.file + "." + randomUUID() + ".tmp";
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(next));
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.file);
      this.value = next;
    } finally {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
}
