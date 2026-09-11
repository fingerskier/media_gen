import { test, expect, vi } from "vitest";
import { RequestRejected } from "../src/main/network";
// Network boundaries here are mocked; these are not live-provider acceptance tests.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../src/main/storage";
import { JobRunner } from "../src/main/jobs";
import type { Provider } from "../src/shared/types";
test("poll errors back off and pause for manual tracking retry; rejected submit is not ambiguous", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-poll-")));
  const job = db.enqueue("retry", {
    mode: "image",
    model: "fixture",
    prompt: "test",
    parameters: {},
  });
  db.claim();
  db.update(job.id, { remoteId: "remote", state: "running" });
  let now = Date.now();
  const poll = vi.fn(async () => {
    throw Error("secret");
  });
  const runner = new JobRunner(
    db,
    { submit: vi.fn(), poll },
    () => "key",
    vi.fn(),
    () => now,
  );
  for (let i = 0; i < 8; i++) {
    await runner.tick();
    now += 180000;
  }
  expect(db.jobs()[0].state).toBe("tracking_failed");
  expect(db.jobs()[0].message).not.toContain("secret");
  runner.retry(job.id);
  expect(db.jobs()[0].state).toBe("running");
  db.update(job.id, { state: "failed" });
  db.enqueue("rejected", {
    mode: "image",
    model: "fixture",
    prompt: "test",
    parameters: {},
  });
  const rejected = new JobRunner(
    db,
    {
      submit: async () => {
        throw new RequestRejected("Atlas API key was rejected.");
      },
      poll: vi.fn(),
    },
    () => "key",
    vi.fn(),
  );
  await rejected.tick();
  expect(db.jobs()[0].state).toBe("failed");
  expect(db.jobs()[0].message).toContain("API key");
  db.close();
});
const recipe = {
  mode: "image" as const,
  model: "fixture/model",
  prompt: "TEST FIXTURE",
  parameters: {},
};
test("fixture boundary: successful async job saves remote ID before polling, saves multiple local outputs, and is ready only after download", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-job-")));
  const job = db.enqueue("token", recipe);
  const provider: Provider = {
    submit: vi.fn(async () => "remote-123"),
    poll: vi.fn(async () => ({
      state: "ready" as const,
      outputs: ["https://cdn.example/a", "https://cdn.example/b"],
    })),
  };
  const download = vi.fn(async () => ({
    id: crypto.randomUUID(),
    filename: "fixture.png",
    mime: "image/png",
    bytes: 10,
    sha256: "hash",
  }));
  const runner = new JobRunner(db, provider, () => "secret", download);
  await runner.tick();
  expect(db.jobs()[0].remoteId).toBe("remote-123");
  expect(provider.poll).not.toHaveBeenCalled();
  await runner.tick();
  expect(db.jobs()[0].state).toBe("ready");
  expect(db.assets()).toHaveLength(2);
  expect(db.assets()[0].jobId).toBe(job.id);
  expect(provider.submit).toHaveBeenCalledTimes(1);
  db.close();
});
test("ambiguous timeout is unknown and is never automatically submitted again", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-job-")));
  db.enqueue("timeout", recipe);
  const submit = vi.fn(async () => {
    throw Error("secret signed-url timeout");
  });
  const runner = new JobRunner(
    db,
    { submit, poll: vi.fn() },
    () => "secret",
    vi.fn(),
  );
  await runner.tick();
  await runner.tick();
  expect(db.jobs()[0].state).toBe("unknown");
  expect(db.jobs()[0].message).not.toContain("secret");
  expect(submit).toHaveBeenCalledTimes(1);
  db.close();
});
test("restart with remote ID resumes safe polling; download failure retries bytes without a paid request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-recover-"));
  let db = new Repository(dir);
  const job = db.enqueue("known", recipe);
  db.claim();
  db.update(job.id, { remoteId: "known-id", state: "running" });
  db.close();
  db = new Repository(dir);
  db.recover();
  const provider: Provider = {
    submit: vi.fn(),
    poll: vi.fn(async () => ({
      state: "ready" as const,
      outputs: ["https://cdn.example/a"],
    })),
  };
  let broken = true;
  const download = vi.fn(async () => {
    if (broken) throw Error("signed secret URL expired");
    return {
      id: crypto.randomUUID(),
      filename: "a.png",
      mime: "image/png",
      bytes: 10,
      sha256: "hash",
    };
  });
  let now = 0;
  const runner = new JobRunner(
    db,
    provider,
    () => "secret",
    download,
    () => now,
  );
  for (let i = 0; i < 3; i++) {
    await runner.tick();
    now += 120000;
  }
  expect(db.jobs()[0].state).toBe("download_failed");
  expect(db.jobs()[0].outputs).toHaveLength(1);
  expect(db.jobs()[0].message).not.toContain("secret");
  broken = false;
  runner.retry(job.id);
  await runner.tick();
  expect(db.jobs()[0].state).toBe("ready");
  expect(provider.submit).not.toHaveBeenCalled();
  expect(provider.poll).toHaveBeenCalledTimes(2);
  db.close();
});
test("queued cancellation cannot cancel submitted jobs; stop survives an awaited poll", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-stop-")));
  const job = db.enqueue("stop", recipe);
  let finish!: (value: { state: "running" }) => void;
  const poll = vi.fn(
    () => new Promise<{ state: "running" }>((r) => (finish = r)),
  );
  const runner = new JobRunner(
    db,
    { submit: async () => "same-id", poll },
    () => "key",
    vi.fn(),
  );
  runner.cancelQueued(job.id);
  expect(db.jobs()[0].state).toBe("cancelled");
  const next = db.enqueue("next", recipe);
  await runner.tick();
  expect(() => runner.cancelQueued(next.id)).toThrow();
  const tick = runner.tick();
  runner.stopTracking(next.id);
  finish({ state: "running" });
  await tick;
  expect(db.jobs()[0].state).toBe("paused");
  expect(db.jobs()[0].remoteId).toBe("same-id");
  runner.retry(next.id);
  expect(db.jobs()[0].state).toBe("running");
  db.close();
});
test("successful pending reads reset consecutive errors while total tracking remains bounded", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-count-")));
  const job = db.enqueue("count", recipe);
  db.claim();
  db.update(job.id, { state: "running", remoteId: "same" });
  let now = 0;
  let fail = false;
  const poll = vi.fn(async () => {
    if (fail) throw Error("secret");
    return { state: "running" as const };
  });
  const runner = new JobRunner(
    db,
    { submit: vi.fn(), poll },
    () => "key",
    vi.fn(),
    () => now,
  );
  for (let i = 0; i < 9; i++) {
    await runner.tick();
    now += 5000;
  }
  fail = true;
  await runner.tick();
  expect(db.jobs()[0].state).toBe("running");
  expect(db.jobs()[0].attempts).toBe(1);
  now += 120000;
  fail = false;
  await runner.tick();
  expect(db.jobs()[0].attempts).toBe(0);
  now += 3600001;
  await runner.tick();
  expect(db.jobs()[0].state).toBe("tracking_failed");
  db.close();
});
test("download retry refreshes expired URL by polling the retained remote ID without submit", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-expired-")));
  const job = db.enqueue("expired", recipe);
  db.claim();
  db.update(job.id, { state: "running", remoteId: "same-id" });
  const oldURL = "https://cdn.example/old",
    freshURL = "https://cdn.example/fresh";
  let now = 0;
  const poll = vi
    .fn()
    .mockResolvedValueOnce({ state: "ready", outputs: [oldURL] })
    .mockResolvedValue({ state: "ready", outputs: [freshURL] });
  const download = vi.fn(async (url: string) => {
    if (url === oldURL) throw new RequestRejected("404");
    return {
      id: "fresh",
      filename: "fresh.png",
      mime: "image/png",
      bytes: 10,
      sha256: "hash",
    };
  });
  const submit = vi.fn();
  const runner = new JobRunner(
    db,
    { submit, poll },
    () => "key",
    download,
    () => now,
  );
  for (let i = 0; i < 3; i++) {
    await runner.tick();
    now += 120000;
  }
  expect(db.jobs()[0].state).toBe("download_failed");
  runner.retry(job.id);
  await runner.tick();
  expect(download).toHaveBeenLastCalledWith(freshURL, "image");
  expect(poll).toHaveBeenLastCalledWith("same-id", "key");
  expect(db.jobs()[0].state).toBe("ready");
  expect(db.jobs()[0].remoteId).toBe("same-id");
  expect(submit).not.toHaveBeenCalled();
  db.close();
});
test("account mismatch pauses queued and remote jobs until original reference is restored", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-account-")));
  const job = db.enqueue("account", recipe, "original");
  const submit = vi.fn(async () => "remote");
  const poll = vi.fn(async () => ({ state: "running" as const }));
  let reference = "other";
  const runner = new JobRunner(
    db,
    { submit, poll },
    () => "fixture-key",
    vi.fn(),
    () => 0,
    () => reference,
  );
  await runner.tick();
  expect(db.jobs()[0].state).toBe("paused");
  expect(submit).not.toHaveBeenCalled();
  expect(db.jobs()[0].provider).toBe("atlas");
  reference = "original";
  runner.retry(job.id);
  await runner.tick();
  expect(submit).toHaveBeenCalledTimes(1);
  reference = "other";
  await runner.tick();
  expect(db.jobs()[0].state).toBe("paused");
  expect(poll).not.toHaveBeenCalled();
  expect(db.jobs()[0].remoteId).toBe("remote");
  reference = "original";
  runner.retry(job.id);
  await runner.tick();
  expect(poll).toHaveBeenCalledWith("remote", "fixture-key");
  expect(submit).toHaveBeenCalledTimes(1);
  db.close();
});
test("Retry-After gates status reads and failed downloads; successful read resets error count", async () => {
  const db = new Repository(mkdtempSync(join(tmpdir(), "media-delay-")));
  const job = db.enqueue("delay", recipe);
  db.claim();
  db.update(job.id, { state: "running", remoteId: "same" });
  let now = 0;
  const poll = vi
    .fn()
    .mockRejectedValueOnce(
      new RequestRejected("Atlas rate limit reached.", 600000),
    )
    .mockResolvedValue({ state: "ready", outputs: ["https://cdn.example/a"] });
  const download = vi
    .fn()
    .mockRejectedValue(
      new RequestRejected(
        "retry",
        parseRetryAfter(new Date(1200000).toUTCString(), 600000),
      ),
    );
  const runner = new JobRunner(
    db,
    { submit: vi.fn(), poll },
    () => "key",
    download,
    () => now,
  );
  await runner.tick();
  now = 599999;
  await runner.tick();
  expect(poll).toHaveBeenCalledTimes(1);
  now = 600000;
  await runner.tick();
  expect(poll).toHaveBeenCalledTimes(2);
  expect(db.jobs()[0].attempts).toBe(0);
  now = 1199999;
  await runner.tick();
  expect(download).toHaveBeenCalledTimes(1);
  now = 1200000;
  await runner.tick();
  expect(download).toHaveBeenCalledTimes(2);
  db.close();
});
test("stopping during download cannot mark paused job ready or begin later outputs", async () => {
  const db = new Repository(
    mkdtempSync(join(tmpdir(), "media-stop-download-")),
  );
  const job = db.enqueue("download", recipe);
  db.claim();
  db.update(job.id, { state: "running", remoteId: "same" });
  let finish!: (value: any) => void;
  const download = vi.fn(
    () => new Promise<any>((resolve) => (finish = resolve)),
  );
  const runner = new JobRunner(
    db,
    {
      submit: vi.fn(),
      poll: async () => ({ state: "ready", outputs: ["a", "b"] }),
    },
    () => "key",
    download,
  );
  const tick = runner.tick();
  await Promise.resolve();
  runner.stopTracking(job.id);
  finish({
    id: "a",
    filename: "a.png",
    mime: "image/png",
    bytes: 1,
    sha256: "hash",
  });
  await tick;
  expect(db.jobs()[0].state).toBe("paused");
  expect(db.assets()).toHaveLength(0);
  expect(download).toHaveBeenCalledTimes(1);
  db.close();
});

import { NetworkFailure, parseRetryAfter } from "../src/main/network";
test.each(["status", "download"] as const)(
  "%s preserves provider gates across pause, persisted reload and manual Resume",
  async (phase) => {
    for (const dateHeader of [false, true]) {
      for (const delay of [600000, 7200000, 999999000]) {
        const dir = mkdtempSync(join(tmpdir(), "media-provider-wait-"));
        let db = new Repository(dir);
        const job = db.enqueue("wait", recipe);
        db.claim();
        const start = Date.UTC(2026, 8, 11);
        // Only five minutes remain: even a ten-minute wait must pause.
        let now = start + 55 * 60000;
        db.update(job.id, {
          state: "running",
          remoteId: "same",
          trackingStarted: start,
        });
        const header = dateHeader
          ? new Date(now + delay).toUTCString()
          : String(delay / 1000);
        const failure = new NetworkFailure(
          "provider wait",
          parseRetryAfter(header, now),
        );
        const poll = vi.fn().mockResolvedValue({
          state: "ready",
          outputs: ["https://cdn.example/a"],
        });
        const download = vi.fn().mockResolvedValue({
          id: "asset",
          filename: "a.png",
          mime: "image/png",
          bytes: 1,
          sha256: "hash",
        });
        if (phase === "status") poll.mockRejectedValueOnce(failure);
        else download.mockRejectedValueOnce(failure);
        const submit = vi.fn();
        let runner = new JobRunner(
          db,
          { submit, poll },
          () => "key",
          download,
          () => now,
        );
        await runner.tick();
        const gate = now + delay;
        expect(db.jobs()[0].nextPoll).toBe(gate);
        expect(db.jobs()[0].state).toBe("paused");
        db.close();
        db = new Repository(dir);
        db.recover();
        runner = new JobRunner(
          db,
          { submit, poll },
          () => "key",
          download,
          () => now,
        );
        runner.retry(job.id);
        expect(db.jobs()[0].nextPoll).toBe(gate);
        await runner.tick();
        now = gate - 1;
        runner.stopTracking(job.id);
        runner.retry(job.id);
        await runner.tick();
        expect(poll).toHaveBeenCalledTimes(1);
        expect(download).toHaveBeenCalledTimes(phase === "download" ? 1 : 0);
        now = gate;
        await runner.tick();
        expect(db.jobs()[0].state).toBe("ready");
        expect(poll).toHaveBeenLastCalledWith("same", "key");
        expect(submit).not.toHaveBeenCalled();
        db.close();
      }
    }
  },
);

test.each(["paused", "tracking_failed", "download_failed"] as const)(
  "Resume from %s retains a future gate until its exact boundary",
  async (state) => {
    const db = new Repository(
      mkdtempSync(join(tmpdir(), "media-resume-gate-")),
    );
    const job = db.enqueue("resume", recipe);
    db.claim();
    db.update(job.id, { state, remoteId: "same", nextPoll: 600000 });
    let now = 0;
    const poll = vi.fn().mockResolvedValue({ state: "running" });
    const submit = vi.fn();
    const runner = new JobRunner(
      db,
      { submit, poll },
      () => "key",
      vi.fn(),
      () => now,
    );
    runner.retry(job.id);
    expect(db.jobs()[0].nextPoll).toBe(600000);
    now = 599999;
    await runner.tick();
    expect(poll).not.toHaveBeenCalled();
    now = 600000;
    await runner.tick();
    expect(poll).toHaveBeenCalledExactlyOnceWith("same", "key");
    expect(submit).not.toHaveBeenCalled();
    db.close();
  },
);
test("locally computed exponential retry delay remains bounded at two minutes", async () => {
  const db = new Repository(
    mkdtempSync(join(tmpdir(), "media-local-backoff-")),
  );
  const job = db.enqueue("backoff", recipe);
  db.claim();
  db.update(job.id, {
    state: "running",
    remoteId: "same",
    attempts: 6,
    trackingStarted: 0,
  });
  const runner = new JobRunner(
    db,
    {
      submit: vi.fn(),
      poll: vi.fn().mockRejectedValue(new NetworkFailure("temporary")),
    },
    () => "key",
    vi.fn(),
    () => 0,
  );
  await runner.tick();
  expect(db.jobs()[0].nextPoll).toBe(120000);
  expect(db.jobs()[0].state).toBe("running");
  db.close();
});
