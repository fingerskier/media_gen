import { test, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
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
  expect(c.status().storage).toBe("session");
  expect(JSON.stringify(c.status())).not.toContain("test-private-key");
  expect(existsSync(join(dir, "atlas-key.bin"))).toBe(false);
  c.clear();
  expect(c.get()).toBeUndefined();
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
