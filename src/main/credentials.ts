import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
} from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "../shared/types";
interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}
type Storage = Snapshot["credentials"]["storage"];
export class Credentials {
  private key?: string;
  private storage: Storage = "none";
  // Encrypted through the OS keyring when one is available; otherwise a user-only plain file.
  private encryptedFile: string;
  private plainFile: string;
  constructor(
    root: string,
    private secure: SecureStorage,
    environmentKey?: string,
  ) {
    this.encryptedFile = join(root, "atlas-key.bin");
    this.plainFile = join(root, "atlas-key.txt");
    if (environmentKey) {
      this.key = environmentKey;
      this.storage = "environment";
      return;
    }
    if (existsSync(this.encryptedFile) && this.secureAvailable())
      try {
        this.key = secure.decryptString(readFileSync(this.encryptedFile));
        this.storage = "encrypted";
        return;
      } catch {
        /* Locked or unavailable keyring: fall through to any plain file, else require entry. */
      }
    try {
      const key = readPlain(this.plainFile);
      if (key === undefined) return;
      this.key = key;
      this.storage = "file";
      // A keyring that became available later takes over from the plain file.
      if (this.secureAvailable()) this.save(key);
    } catch {
      /* A corrupt key file only means the key must be entered again. */
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
  save(input: string) {
    const key = input.trim();
    if (!valid(key)) throw Error("Enter a valid API key");
    if (this.secureAvailable()) {
      write(this.encryptedFile, this.secure.encryptString(key));
      remove(this.plainFile);
      this.storage = "encrypted";
    } else {
      write(this.plainFile, key + "\n");
      remove(this.encryptedFile);
      this.storage = "file";
    }
    this.key = key;
  }
  clear() {
    // Delete before forgetting so a failed deletion surfaces instead of resurfacing next launch.
    remove(this.encryptedFile);
    remove(this.plainFile);
    this.key = undefined;
    this.storage = "none";
  }
}
function valid(key: string) {
  return key.length > 0 && key.length <= 4096 && !/[\r\n]/.test(key);
}
// Exclusive create on an unpredictable name never follows a planted symlink; rename is atomic.
function write(file: string, content: Buffer | string) {
  const target = lstatSync(file, { throwIfNoEntry: false });
  if (target && !target.isFile()) throw Error("Unsafe key file");
  const temp = file + "." + randomUUID() + ".tmp";
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
// Only a missing file is fine to ignore; any other failure must reach the caller.
function remove(file: string) {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
// Opened without following symlinks; a restored or copied file gets its user-only mode back.
function readPlain(file: string): string | undefined {
  const target = lstatSync(file, { throwIfNoEntry: false });
  if (!target) return undefined;
  // O_NOFOLLOW is unavailable on Windows, so refuse links from the lstat result as well.
  if (!target.isFile()) throw Error("Unsafe key file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) throw Error("Unsafe key file");
    if (stat.mode & 0o077) fchmodSync(fd, 0o600);
    const key = readFileSync(fd, "utf8").trim();
    if (!valid(key)) throw Error("Unreadable key file");
    return key;
  } finally {
    closeSync(fd);
  }
}
