import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  lstatSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, parse } from "node:path";
import { randomUUID } from "node:crypto";
import type { Recipe, Job, State, Asset, Downloaded } from "../shared/types";

// Managed paths must not traverse symlinks, including an ancestor of the library.
export function assertDirectory(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split("/")
    .filter(Boolean)) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw Error("Unsafe library directory");
  }
}
export class Repository {
  readonly db: DatabaseSync;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertDirectory(root);
    chmodSync(root, 0o700);
    mkdirSync(join(root, "assets"), { recursive: true, mode: 0o700 });
    assertDirectory(join(root, "assets"));
    const file = join(root, "library.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (
        lstatSync(file + suffix, { throwIfNoEntry: false })?.isFile() === false
      )
        throw Error("Unsafe library file");
    }
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()!.user_version,
      );
      if (version > 2)
        throw Error("Library schema is newer than this application");
      if (version === 0)
        this.db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE jobs(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,created INTEGER NOT NULL,recipe TEXT NOT NULL,state TEXT NOT NULL,remote_id TEXT,outputs TEXT,message TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_poll INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE assets(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),filename TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL);
    PRAGMA user_version=1; COMMIT;`);
      if (version < 2) {
        // VACUUM INTO creates a consistent snapshot including any committed WAL pages.
        // Never overwrite a prior backup; its presence cannot authorize a symlink write.
        if (version === 1) {
          const backup = join(root, "library.v1.backup.db");
          if (lstatSync(backup, { throwIfNoEntry: false }))
            throw Error(
              "Migration backup already exists; review library before retrying migration",
            );
          this.db.prepare("VACUUM INTO ?").run(backup);
          chmodSync(backup, 0o600);
        }
        this.db.exec(`BEGIN IMMEDIATE;
     ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'atlas';
     ALTER TABLE jobs ADD COLUMN credential_ref TEXT;
     ALTER TABLE jobs ADD COLUMN poll_count INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE jobs ADD COLUMN tracking_started INTEGER;
     ALTER TABLE jobs ADD COLUMN download_attempts INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE assets ADD COLUMN width INTEGER;
     ALTER TABLE assets ADD COLUMN height INTEGER;
     ALTER TABLE assets ADD COLUMN duration REAL;
     PRAGMA user_version=2; COMMIT;`);
      }
      this.db.exec("PRAGMA journal_mode=WAL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private decode(row: Record<string, unknown>): Job {
    return {
      id: String(row.id),
      created: Number(row.created),
      recipe: JSON.parse(String(row.recipe)),
      state: row.state as State,
      provider: "atlas",
      credentialRef: row.credential_ref as string | undefined,
      remoteId: row.remote_id as string | undefined,
      outputs: row.outputs ? JSON.parse(String(row.outputs)) : undefined,
      message: row.message as string | undefined,
      attempts: Number(row.attempts),
      nextPoll: Number(row.next_poll),
      pollCount: Number(row.poll_count),
      trackingStarted:
        row.tracking_started == null ? undefined : Number(row.tracking_started),
      downloadAttempts: Number(row.download_attempts),
    };
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY created DESC,rowid DESC")
      .all()
      .map((row) => this.decode(row));
  }
  enqueue(token: string, recipe: Recipe, credentialRef?: string): Job {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs(id,token,created,recipe,state,provider,credential_ref) VALUES(?,?,?,?,'queued','atlas',?)",
      )
      .run(
        randomUUID(),
        token,
        Date.now(),
        JSON.stringify(recipe),
        credentialRef ?? null,
      );
    return this.decode(
      this.db.prepare("SELECT * FROM jobs WHERE token=?").get(token)!,
    );
  }
  claim(): Job | undefined {
    const row = this.db
      .prepare(
        "UPDATE jobs SET state='submitting' WHERE id=(SELECT id FROM jobs WHERE state='queued' ORDER BY created,rowid LIMIT 1) AND NOT EXISTS(SELECT 1 FROM jobs WHERE state IN ('submitting','running','downloading')) RETURNING *",
      )
      .get();
    return row ? this.decode(row) : undefined;
  }
  recover() {
    this.db.exec(
      "UPDATE jobs SET state='unknown',message='Submission outcome is unknown. Check your Atlas account before creating another paid request.' WHERE state='submitting' AND remote_id IS NULL; UPDATE jobs SET state='running' WHERE state='submitting' AND remote_id IS NOT NULL;",
    );
    const directory = join(this.root, "assets");
    assertDirectory(directory);
    const referenced = new Set(this.assets().map((asset) => asset.filename));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Only our content-addressed files and uniquely named temporary writes belong to us.
      if (!entry.isFile() || referenced.has(entry.name)) continue;
      if (
        /^[a-f0-9]{64}\.(png|jpg|webp|mp4|webm)(\.[a-f0-9-]{36}\.tmp)?$/.test(
          entry.name,
        )
      )
        unlinkSync(join(directory, entry.name));
    }
  }
  update(
    id: string,
    patch: Partial<
      Pick<
        Job,
        | "state"
        | "remoteId"
        | "outputs"
        | "message"
        | "attempts"
        | "nextPoll"
        | "pollCount"
        | "trackingStarted"
        | "downloadAttempts"
      >
    >,
  ) {
    const columns = {
      state: "state",
      remoteId: "remote_id",
      outputs: "outputs",
      message: "message",
      attempts: "attempts",
      nextPoll: "next_poll",
      pollCount: "poll_count",
      trackingStarted: "tracking_started",
      downloadAttempts: "download_attempts",
    };
    const entries = Object.entries(patch);
    if (!entries.length) return;
    const values = entries.map(([key, value]) => {
      if (!Object.hasOwn(columns, key)) throw Error("Invalid job field");
      return Array.isArray(value) ? JSON.stringify(value) : (value ?? null);
    });
    this.db
      .prepare(
        `UPDATE jobs SET ${entries.map(([key]) => columns[key as keyof typeof columns] + "=?").join(",")} WHERE id=?`,
      )
      .run(...values, id);
  }
  assets(): Asset[] {
    return this.db
      .prepare(
        "SELECT id,job_id AS jobId,filename,mime,bytes,sha256,width,height,duration FROM assets ORDER BY rowid DESC",
      )
      .all() as unknown as Asset[];
  }
  complete(id: string, assets: Downloaded[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const a of assets)
        this.db
          .prepare(
            "INSERT INTO assets(id,job_id,filename,mime,bytes,sha256,width,height,duration) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            a.id,
            id,
            a.filename,
            a.mime,
            a.bytes,
            a.sha256,
            a.width ?? null,
            a.height ?? null,
            a.duration ?? null,
          );
      this.db
        .prepare(
          "UPDATE jobs SET state='ready',outputs=NULL,message=NULL WHERE id=?",
        )
        .run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
