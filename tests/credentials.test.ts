import { test, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials } from "../src/main/credentials";
test("keys persist only through a secure backend and public status never returns a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-key-"));
  const insecure = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text",
    encryptString: () => {
      throw Error("must not encrypt");
    },
    decryptString: () => "",
  };
  const c = new Credentials(dir, insecure);
  c.save("test-private-key");
  expect(c.get()).toBe("test-private-key");
  expect(JSON.stringify(c.status())).not.toContain("test-private-key");
  // Without a usable keyring the key persists in a user-only plain file instead.
  expect(existsSync(join(dir, "atlas-key.bin"))).toBe(false);
  expect(c.status().storage).toBe("file");
  expect(statSync(join(dir, "atlas-key.txt")).mode & 0o777).toBe(0o600);
  expect(new Credentials(dir, insecure).get()).toBe("test-private-key");
  c.clear();
  expect(c.get()).toBeUndefined();
  expect(existsSync(join(dir, "atlas-key.txt"))).toBe(false);
  const secure = {
    ...insecure,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: () => Buffer.from("encrypted-test-fixture"),
    decryptString: () => "test-private-key",
  };
  const stored = new Credentials(dir, secure);
  stored.save("test-private-key");
  expect(readFileSync(join(dir, "atlas-key.bin"), "utf8")).not.toContain(
    "test-private-key",
  );
  expect(new Credentials(dir, secure).get()).toBe("test-private-key");
  stored.clear();
  expect(existsSync(join(dir, "atlas-key.bin"))).toBe(false);
});
test("credential reference is stable and non-secret, changes with key and clears", () => {
  const secure = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  const a = new Credentials(mkdtempSync(join(tmpdir(), "media-ref-")), secure);
  expect(a.reference()).toBeUndefined();
  a.save("fixture-key-A");
  const reference = a.reference();
  expect(reference).toMatch(/^[a-f0-9]{64}$/);
  expect(reference).not.toContain("fixture");
  a.save("fixture-key-A");
  expect(a.reference()).toBe(reference);
  a.save("fixture-key-B");
  expect(a.reference()).not.toBe(reference);
  a.clear();
  expect(a.reference()).toBeUndefined();
});
test("a planted symlink at a temporary name is never followed when saving a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-key-link-"));
  const outside = join(dir, "outside");
  writeFileSync(outside, "original");
  symlinkSync(outside, join(dir, "atlas-key.bin.tmp"));
  const secure = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: () => Buffer.from("encrypted-test-fixture"),
    decryptString: () => "test-private-key",
  };
  new Credentials(dir, secure).save("test-private-key");
  expect(readFileSync(outside, "utf8")).toBe("original");
  expect(readFileSync(join(dir, "atlas-key.bin"), "utf8")).toBe(
    "encrypted-test-fixture",
  );
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([
    "atlas-key.bin.tmp",
  ]);
});
test("a plain key file upgrades to the keyring when one becomes available", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-key-upgrade-"));
  const insecure = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  new Credentials(dir, insecure).save("  test-private-key  ");
  expect(readFileSync(join(dir, "atlas-key.txt"), "utf8")).toBe(
    "test-private-key\n",
  );
  const secure = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text: string) => Buffer.from("enc:" + text),
    decryptString: (bytes: Buffer) => bytes.toString().slice(4),
  };
  const upgraded = new Credentials(dir, secure);
  expect(upgraded.get()).toBe("test-private-key");
  expect(upgraded.status().storage).toBe("encrypted");
  expect(existsSync(join(dir, "atlas-key.txt"))).toBe(false);
  expect(readFileSync(join(dir, "atlas-key.bin"), "utf8")).toBe(
    "enc:test-private-key",
  );
  expect(new Credentials(dir, secure).get()).toBe("test-private-key");
  // A locked keyring at startup means entering the key again, never a crash.
  const locked = {
    ...secure,
    decryptString: () => {
      throw Error("locked");
    },
  };
  expect(new Credentials(dir, locked).get()).toBeUndefined();
});
test("plain key files are refused when symlinked, oversized or malformed", () => {
  const insecure = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  const linked = mkdtempSync(join(tmpdir(), "media-key-plainlink-"));
  writeFileSync(join(linked, "outside"), "secret-elsewhere");
  symlinkSync(join(linked, "outside"), join(linked, "atlas-key.txt"));
  expect(new Credentials(linked, insecure).get()).toBeUndefined();
  expect(() => new Credentials(linked, insecure).save("new-key")).toThrow();
  expect(readFileSync(join(linked, "outside"), "utf8")).toBe(
    "secret-elsewhere",
  );
  const big = mkdtempSync(join(tmpdir(), "media-key-big-"));
  writeFileSync(join(big, "atlas-key.txt"), "k".repeat(9000));
  expect(new Credentials(big, insecure).get()).toBeUndefined();
  const multi = mkdtempSync(join(tmpdir(), "media-key-multi-"));
  writeFileSync(join(multi, "atlas-key.txt"), "one\ntwo\n");
  expect(new Credentials(multi, insecure).get()).toBeUndefined();
});
test("a loosely permissioned key file is tightened on load, not silently trusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-key-mode-"));
  const insecure = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  writeFileSync(join(dir, "atlas-key.txt"), "restored-key\n", { mode: 0o644 });
  const c = new Credentials(dir, insecure);
  expect(c.get()).toBe("restored-key");
  expect(c.status().storage).toBe("file");
  expect(statSync(join(dir, "atlas-key.txt")).mode & 0o777).toBe(0o600);
});
test("forget key fails loudly when the file cannot be deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-key-locked-"));
  const insecure = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  const c = new Credentials(dir, insecure);
  c.save("stuck-key");
  chmodSync(dir, 0o500);
  try {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    expect(() => c.clear()).toThrow();
    expect(c.get()).toBe("stuck-key");
    expect(c.status().storage).toBe("file");
    expect(existsSync(join(dir, "atlas-key.txt"))).toBe(true);
  } finally {
    chmodSync(dir, 0o700);
  }
  c.clear();
  expect(c.get()).toBeUndefined();
  expect(existsSync(join(dir, "atlas-key.txt"))).toBe(false);
});
