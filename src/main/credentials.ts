import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../shared/types";
interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}
export class Credentials {
  private key?: string;
  private storage: Snapshot["credentials"]["storage"] = "none";
  private file: string;
  constructor(
    root: string,
    private secure: SecureStorage,
    environmentKey?: string,
  ) {
    this.file = join(root, "atlas-key.bin");
    if (environmentKey) {
      this.key = environmentKey;
      this.storage = "environment";
      return;
    }
    if (existsSync(this.file) && this.secureAvailable())
      try {
        this.key = secure.decryptString(readFileSync(this.file));
        this.storage = "encrypted";
      } catch {
        /* Locked or unavailable keyring: require key entry again. */
      }
  }
  private secureAvailable() {
    return (
      this.secure.isEncryptionAvailable() &&
      this.secure.getSelectedStorageBackend?.() !== "basic_text"
    );
  }
  get() {
    return this.key;
  }
  reference() {
    return this.key
      ? createHash("sha256")
          .update("atlas-credential:")
          .update(this.key)
          .digest("hex")
      : undefined;
  }
  status(): Snapshot["credentials"] {
    return {
      configured: !!this.key,
      storage: this.storage,
      secureAvailable: this.secureAvailable(),
    };
  }
  save(key: string) {
    if (!key.trim() || key.length > 4096 || /[\r\n]/.test(key))
      throw Error("Enter a valid API key");
    if (this.secureAvailable()) {
      // Exclusive create on an unpredictable name never follows a planted symlink.
      const temp = this.file + "." + randomUUID() + ".tmp";
      const fd = openSync(temp, "wx", 0o600);
      try {
        try {
          writeFileSync(fd, this.secure.encryptString(key.trim()));
        } finally {
          closeSync(fd);
        }
        renameSync(temp, this.file);
      } finally {
        try {
          unlinkSync(temp);
        } catch {}
      }
      this.storage = "encrypted";
    } else {
      if (existsSync(this.file)) unlinkSync(this.file);
      this.storage = "session";
    }
    this.key = key.trim();
  }
  clear() {
    if (existsSync(this.file)) unlinkSync(this.file);
    this.key = undefined;
    this.storage = "none";
  }
}
