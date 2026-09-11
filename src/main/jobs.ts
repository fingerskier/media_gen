import type { Provider, Downloaded, Mode, Job } from "../shared/types";
import { Repository } from "./storage";
import { RequestRejected, NetworkFailure } from "./network";

const MAX_ERRORS = 8;
const MAX_POLLS = 720;
const TRACKING_WINDOW = 60 * 60 * 1000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
function retryDelay(attempt: number, error: unknown) {
  const retryAfter =
    error instanceof NetworkFailure ? error.retryAfterMs : undefined;
  return Math.max(
    2000,
    retryAfter ?? Math.min(120000, 2000 * 2 ** Math.min(attempt, 6)),
  );
}
export class JobRunner {
  private busy = false;
  private revisions = new Map<string, number>();
  constructor(
    private db: Repository,
    private provider: Provider,
    private key: () => string | undefined,
    private download: (url: string, mode: Mode) => Promise<Downloaded>,
    private now = () => Date.now(),
    private reference?: () => string | undefined,
  ) {}
  cancelQueued(id: string) {
    const result = this.db.db
      .prepare(
        "UPDATE jobs SET state='cancelled' WHERE id=? AND state='queued'",
      )
      .run(id);
    if (!result.changes) throw Error("Only queued jobs can be cancelled");
  }
  stopTracking(id: string) {
    const result = this.db.db
      .prepare(
        "UPDATE jobs SET state='paused',message='Local tracking paused. Provider processing and billing may continue.' WHERE id=? AND state IN ('running','tracking_failed','download_failed','downloading')",
      )
      .run(id);
    if (!result.changes) throw Error("This job cannot pause tracking");
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }
  retry(id: string) {
    const job = this.db.jobs().find((j) => j.id === id);
    if (
      !job ||
      !["download_failed", "tracking_failed", "paused"].includes(job.state)
    )
      throw Error("This job cannot retry safely");
    this.db.update(id, {
      state: job.remoteId ? "running" : "queued",
      message: undefined,
      attempts: 0,
      // Resume must not bypass a persisted provider not-before time.
      nextPoll: job.nextPoll,
      pollCount: 0,
      trackingStarted: this.now(),
      downloadAttempts: 0,
    });
  }
  private matchingCredential(job: Job) {
    if (!job.credentialRef || job.credentialRef === this.reference?.())
      return true;
    this.db.update(job.id, {
      state: "paused",
      message:
        "Restore the original Atlas API key, then resume this job. No request was sent with the current key.",
    });
    return false;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const active = this.db
        .jobs()
        .find((j) => ["running", "downloading"].includes(j.state));
      if (active) {
        const revision = this.revisions.get(active.id) ?? 0;
        const stopped = () => revision !== (this.revisions.get(active.id) ?? 0);
        if (!this.matchingCredential(active)) return;
        if (active.state === "running") {
          const started = active.trackingStarted ?? this.now();
          if (
            this.now() - started >= TRACKING_WINDOW ||
            (active.pollCount ?? 0) >= MAX_POLLS
          ) {
            this.db.update(active.id, {
              state: "tracking_failed",
              message:
                "Tracking time limit reached. Resume tracking to check the existing job.",
            });
            return;
          }
          const key = this.key();
          if (!key || active.nextPoll > this.now()) return;
          this.db.update(active.id, {
            trackingStarted: started,
            pollCount: (active.pollCount ?? 0) + 1,
          });
          try {
            // Atlas prediction reads use the retained ID; retry never repeats generate POST.
            // https://www.atlascloud.ai/models/black-forest-labs/flux-schnell/llms.txt
            const result = await this.provider.poll(active.remoteId!, key);
            if (stopped()) return;
            if (result.state === "running") {
              this.db.update(active.id, {
                attempts: 0,
                message: undefined,
                nextPoll:
                  this.now() + (active.recipe.mode === "image" ? 2000 : 5000),
              });
              return;
            }
            if (result.state === "failed") {
              this.db.update(active.id, {
                state: "failed",
                message:
                  "Atlas reported generation failure. Check the provider dashboard for details.",
              });
              return;
            }
            if (!result.outputs?.length) throw Error("Missing outputs");
            this.db.update(active.id, {
              outputs: result.outputs,
              state: "downloading",
              message: undefined,
              attempts: 0,
              nextPoll: 0,
            });
            active.outputs = result.outputs;
          } catch (error) {
            if (stopped()) return;
            const attempts = active.attempts + 1;
            const nextPoll = this.now() + retryDelay(attempts, error);
            const exceedsWindow = nextPoll > started + TRACKING_WINDOW;
            this.db.update(active.id, {
              attempts,
              nextPoll,
              message: exceedsWindow
                ? "Retry wait exceeds the tracking time limit. Tracking paused; Resume will retain the wait."
                : "Unable to read job status. Your remote job may still be running.",
              ...(exceedsWindow
                ? { state: "paused" as const }
                : attempts >= MAX_ERRORS
                  ? { state: "tracking_failed" as const }
                  : {}),
            });
            return;
          }
        } else if (active.nextPoll > this.now()) return;
        try {
          const assets: Downloaded[] = [];
          for (const url of active.outputs ?? []) {
            if (stopped()) return;
            assets.push(await this.download(url, active.recipe.mode));
          }
          if (stopped()) return;
          if (!assets.length) throw Error("No outputs");
          this.db.complete(active.id, assets);
        } catch (error) {
          if (stopped()) return;
          const attempts = (active.downloadAttempts ?? 0) + 1;
          const nextPoll = this.now() + retryDelay(attempts, error);
          const exceedsWindow =
            nextPoll > (active.trackingStarted ?? this.now()) + TRACKING_WINDOW;
          this.db.update(active.id, {
            state: exceedsWindow
              ? "paused"
              : attempts >= MAX_DOWNLOAD_ATTEMPTS
                ? "download_failed"
                : "downloading",
            downloadAttempts: attempts,
            nextPoll,
            message: exceedsWindow
              ? "Retry wait exceeds the tracking time limit. Tracking paused; Resume will retain the wait."
              : attempts >= MAX_DOWNLOAD_ATTEMPTS
                ? "Output download failed. Retry to refresh output links without another generation charge."
                : "Output download interrupted. Retrying safely.",
          });
        }
        return;
      }
      const queued = this.db
        .jobs()
        .filter((job) => job.state === "queued")
        .at(-1);
      if (queued && !this.matchingCredential(queued)) return;
      const key = this.key();
      if (!key) return;
      const job = this.db.claim();
      if (!job) return;
      try {
        const id = await this.provider.submit(job.recipe, key);
        this.db.update(job.id, {
          remoteId: id,
          state: "running",
          trackingStarted: this.now(),
        });
      } catch (error) {
        this.db.update(
          job.id,
          error instanceof RequestRejected
            ? { state: "failed", message: error.safeMessage }
            : {
                state: "unknown",
                message:
                  "Submission outcome is unknown. Check your Atlas account before creating another paid request.",
              },
        );
      }
    } finally {
      this.busy = false;
    }
  }
}
