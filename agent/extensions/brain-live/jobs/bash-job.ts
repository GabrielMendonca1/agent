import { spawn } from "node:child_process";
import { closeSync, createWriteStream, fchmodSync, openSync } from "node:fs";
import { userCommandEnv } from "../../../core/child-env.mjs";

export interface BashJob {
  done: Promise<{ status: "done" | "failed" | "cancelled"; exitCode: number | null; error?: string }>;
  cancel(): void;
  output(): string;
}

export function startBashJob(command: string, cwd: string, logPath: string): BashJob {
  const fd = openSync(logPath, "a", 0o600);
  try { fchmodSync(fd, 0o600); } catch (error) { closeSync(fd); throw error; }
  const log = createWriteStream(logPath, { fd, autoClose: true });
  const child = spawn(process.platform === "win32" ? "bash.exe" : "bash", ["-c", command], {
    cwd, env: userCommandEnv(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  let cancelled = false;
  let error: string | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (force: boolean) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", env: userCommandEnv() });
        killer.on("error", () => {});
      } else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch { /* Process group already stopped. */ }
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    kill(false);
    escalation = setTimeout(() => kill(true), 1000);
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { tail = (tail + chunk).slice(-16_384); });
    stream.pipe(log, { end: false });
  }
  log.on("error", (err) => { error = err.message; cancel(); });
  const done = new Promise<{ status: "done" | "failed" | "cancelled"; exitCode: number | null; error?: string }>((resolve) => {
    child.on("error", (err) => { error = err.message; });
    child.on("close", (exitCode) => {
      const finish = () => resolve({ status: error ? "failed" : cancelled ? "cancelled" : exitCode === 0 ? "done" : "failed", exitCode, ...(error ? { error } : {}) });
      // Retain escalation until it fires: descendants can survive the shell's exit.
      if (!cancelled) clearTimeout(escalation);
      if (log.destroyed) finish();
      else log.end(finish);
    });
  });
  return { done, cancel, output: () => tail };
}
