import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startBashJob, type BashJob } from "./bash-job.ts";

export type JobStatus = "running" | "done" | "failed" | "cancelled";
export interface JobRecord {
  jobId: string;
  kind: "bash" | "codemode";
  sessionId: string;
  status: JobStatus;
  logPath?: string;
  command?: string;
  result?: string;
  exitCode?: number | null;
  child?: BashJob;
  detached: boolean;
  delivered: boolean;
  foreground: number;
  done: Promise<void>;
  settle: () => void;
}

export class JobRegistry {
  private records = new Map<string, JobRecord>();
  constructor(private onComplete: (job: JobRecord) => void, private cancelCodemode: (jobId: string) => void) {}

  private create(jobId: string, kind: JobRecord["kind"], sessionId: string): JobRecord {
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const job: JobRecord = { jobId, kind, sessionId, status: "running", detached: false, delivered: false, foreground: 0, done, settle };
    this.records.set(jobId, job);
    return job;
  }
  start(command: string, cwd: string, sessionDir: string, sessionId: string): JobRecord {
    const dir = join(sessionDir, "jobs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const job = this.create(`j_${randomUUID()}`, "bash", sessionId);
    job.command = command;
    job.logPath = join(dir, `${job.jobId}.log`);
    job.child = startBashJob(command, cwd, job.logPath);
    void job.child.done.then(result => {
      job.exitCode = result.exitCode;
      this.finish(job, result.status, `${job.child!.output()}${result.error ? `\n${result.error}` : ""}`);
    });
    return job;
  }
  codemode(jobId: string, sessionId: string, status: JobStatus, result?: string): void {
    const job = this.records.get(jobId) ?? this.create(jobId, "codemode", sessionId);
    if (job.kind !== "codemode" || job.sessionId !== sessionId) return;
    if (status === "running") job.detached = true;
    if (status !== "running") this.finish(job, status, result ?? "");
  }
  private finish(job: JobRecord, status: JobStatus, result: string): void {
    if (job.status !== "running") return;
    job.status = status;
    job.result = result;
    job.settle();
    this.onComplete(job);
  }
  get(jobId: string, sessionId: string): JobRecord {
    const job = this.records.get(jobId);
    if (!job || job.sessionId !== sessionId) throw new Error(`Unknown job ${jobId}`);
    return job;
  }
  list(sessionId: string): JobRecord[] { return [...this.records.values()].filter(job => job.sessionId === sessionId); }
  output(job: JobRecord): string { return job.child?.output() ?? job.result ?? ""; }
  async wait(job: JobRecord, timeout_s = 300, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(timeout_s) || timeout_s < 0 || timeout_s > 2147483) throw new Error("timeout_s must be between 0 and 2147483");
    if (job.status !== "running" || signal?.aborted) return;
    job.foreground++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([job.done, new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeout_s * 1000);
        abort = resolve;
        signal?.addEventListener("abort", abort, { once: true });
      })]);
    } finally {
      job.foreground--;
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  cancel(job: JobRecord): void {
    if (job.status !== "running") return;
    if (job.child) job.child.cancel();
    else this.cancelCodemode(job.jobId);
  }
  async shutdown(): Promise<void> {
    const running = [...this.records.values()].filter(job => job.status === "running");
    for (const job of running) this.cancel(job);
    await Promise.all(running.filter(job => job.child).map(job => job.done));
  }
}
