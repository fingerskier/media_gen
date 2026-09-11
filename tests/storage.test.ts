import { test, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../src/main/storage";
export const recipe = {
  mode: "image" as const,
  model: "fixture/model",
  prompt: "TEST FIXTURE",
  parameters: {},
};
test("durably enqueues once per submission token, claims atomically, and recovers ambiguous submission without resending", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-db-"));
  let db = new Repository(dir);
  const a = db.enqueue("click-token", recipe);
  expect(db.enqueue("click-token", recipe).id).toBe(a.id);
  expect(db.claim()?.id).toBe(a.id);
  expect(db.claim()).toBeUndefined();
  db.close();
  db = new Repository(dir);
  db.recover();
  expect(db.jobs()[0].state).toBe("unknown");
  expect(db.claim()).toBeUndefined();
  db.close();
});
test("multi-column updates roll back together when a trigger aborts state change", () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-atomic-")));
  const job = db.enqueue("atomic", recipe);
  db.db.exec(
    "CREATE TRIGGER reject_state BEFORE UPDATE OF state ON jobs BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  expect(() =>
    db.update(job.id, { remoteId: "remote", state: "running" }),
  ).toThrow();
  expect(db.jobs()[0].remoteId).toBeFalsy();
  db.close();
});

import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
test.each(["CREATE TABLE assets", "PRAGMA user_version=1", "COMMIT"])(
  "failed bootstrap before %s rolls back on disk and can reopen",
  (boundary) => {
    const root = mkdtempSync(join(tmpdir(), "media-bootstrap-"));
    const file = join(root, "library.db");
    const originalExec = DatabaseSync.prototype.exec;
    let interrupted = false;
    const exec = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql) {
        if (sql.includes("CREATE TABLE jobs")) {
          const end = sql.indexOf(boundary);
          if (end < 0) throw Error(`Missing bootstrap boundary: ${boundary}`);
          originalExec.call(this, sql.slice(0, end));
          interrupted = true;
          // A real SQLite error after the preceding DDL has executed on disk.
          originalExec.call(this, "SELECT * FROM injected_bootstrap_failure");
        } else originalExec.call(this, sql);
      });
    try {
      expect(() => new Repository(root)).toThrow("injected_bootstrap_failure");
    } finally {
      exec.mockRestore();
    }
    expect(interrupted).toBe(true);
    const disk = new DatabaseSync(file);
    try {
      expect(disk.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
      expect(
        disk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ).toEqual([]);
    } finally {
      disk.close();
    }
    const recovered = new Repository(root);
    const job = recovered.enqueue("after-bootstrap-failure", recipe);
    expect(recovered.assets()).toEqual([]);
    expect(
      recovered.db.prepare("PRAGMA user_version").get()?.user_version,
    ).toBe(2);
    recovered.close();
    const reopened = new Repository(root);
    expect(reopened.jobs()[0].id).toBe(job.id);
    reopened.close();
  },
);

test("failed bootstrap preserves existing unknown tables and user data", () => {
  const root = mkdtempSync(join(tmpdir(), "media-existing-"));
  const file = join(root, "library.db");
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE assets(note TEXT); INSERT INTO assets VALUES('personal data'); CREATE TABLE personal(value TEXT); INSERT INTO personal VALUES('keep');",
  );
  old.close();
  expect(() => new Repository(root)).toThrow("already exists");
  const disk = new DatabaseSync(file);
  try {
    expect(disk.prepare("SELECT note FROM assets").get()?.note).toBe(
      "personal data",
    );
    expect(disk.prepare("SELECT value FROM personal").get()?.value).toBe(
      "keep",
    );
    expect(disk.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(
      disk.prepare("SELECT name FROM sqlite_master WHERE name='jobs'").get(),
    ).toBeUndefined();
  } finally {
    disk.close();
  }
});

test("v1 migration is versioned and backed up; recovery removes only managed orphan files", () => {
  const root = mkdtempSync(join(tmpdir(), "media-v1-"));
  const old = new DatabaseSync(join(root, "library.db"));
  old.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,created INTEGER NOT NULL,recipe TEXT NOT NULL,state TEXT NOT NULL,remote_id TEXT,outputs TEXT,message TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_poll INTEGER NOT NULL DEFAULT 0); CREATE TABLE assets(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),filename TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL); PRAGMA user_version=1;",
  );
  old
    .prepare(
      "INSERT INTO jobs(id,token,created,recipe,state) VALUES('j','t',1,?,'ready')",
    )
    .run(JSON.stringify(recipe));
  const keep = "a".repeat(64) + ".png",
    orphan = "b".repeat(64) + ".mp4",
    temp = orphan + ".12345678-1234-1234-1234-123456789abc.tmp";
  old
    .prepare("INSERT INTO assets VALUES('a','j',?,'image/png',4,'hash')")
    .run(keep);
  old.close();
  mkdirSync(join(root, "assets"));
  for (const name of [keep, orphan, temp, "personal.txt"])
    writeFileSync(join(root, "assets", name), "keep");
  const db = new Repository(root);
  expect(db.db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(existsSync(join(root, "library.v1.backup.db"))).toBe(true);
  const backup = new DatabaseSync(join(root, "library.v1.backup.db"));
  expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  backup.close();
  db.recover();
  expect(readFileSync(join(root, "assets", keep), "utf8")).toBe("keep");
  expect(existsSync(join(root, "assets", orphan))).toBe(false);
  expect(existsSync(join(root, "assets", temp))).toBe(false);
  expect(existsSync(join(root, "assets", "personal.txt"))).toBe(true);
  expect(db.jobs()[0].provider).toBe("atlas");
  db.close();
});

import { symlinkSync } from "node:fs";
test("a dangling database symlink cannot create an external database", () => {
  const root = mkdtempSync(join(tmpdir(), "media-db-link-"));
  const external = join(
    mkdtempSync(join(tmpdir(), "media-outside-")),
    "outside.db",
  );
  symlinkSync(external, join(root, "library.db"));
  expect(() => new Repository(root)).toThrow();
  expect(existsSync(external)).toBe(false);
});
