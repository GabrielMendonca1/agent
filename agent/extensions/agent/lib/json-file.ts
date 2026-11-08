import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/u, "")) as T;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
