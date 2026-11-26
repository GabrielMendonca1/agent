import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChild, runtimeEnabled } from "../../core/client.mjs";
import { listActiveWorkspaces, registerWorkspace, unregisterWorkspace, updateWorkspaceScope, validateWorktreeSlug } from "./subagent/workspace.ts";
import { discardWorktreeBranch, integrateWorktreeBranch, type WorktreeBranch } from "./subagent/worktrees.ts";

const STATUS = "agent-workspace";
const PREFIX = "agent/session-";
const USAGE = "/workspace [status | claim <text> | integrate | discard [--force]]";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
}

function sessionWorktree(cwd: string): WorktreeBranch | undefined {
  const { AGENT_WORKTREE_SESSION: worktree, AGENT_WORKTREE_SOURCE: sourceCwd,
    AGENT_WORKTREE_BRANCH: sourceBranch, AGENT_WORKTREE_NAME: branch } = process.env;
  if (!worktree || !sourceCwd || !sourceBranch || !branch || !isAbsolute(worktree) || !isAbsolute(sourceCwd)
    || !branch.startsWith(PREFIX) || !validateWorktreeSlug(branch.slice(PREFIX.length))) return;
  if (realpathSync(git(cwd, "rev-parse", "--show-toplevel")) !== worktree) return;
  return { worktree, sourceCwd, sourceBranch, branch };
}

// Discovered as a standalone brain-live extension; no tools or prompt hooks.
export default function (pi: ExtensionAPI) {
  if (!runtimeEnabled() || isChild()) return;
  const id = `session-${randomUUID()}`;
  let target: WorktreeBranch | undefined;
  let repo: string | undefined;
  let registered = false;
  let busy = false;
  let badgeTimer: ReturnType<typeof setInterval> | undefined;

  function badge(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    let others = 0;
    try { if (repo) others = listActiveWorkspaces(repo).filter((entry) => entry.id !== id).length; }
    catch { /* Status is best effort; /workspace status reports registry errors. */ }
    const text = [target && `wt:${target.branch.slice(PREFIX.length)}`, others && `${others} active`].filter(Boolean).join(" · ");
    ctx.ui.setStatus(STATUS, text ? ctx.ui.theme.fg("dim", text) : undefined);
  }

  function stop() {
    if (badgeTimer) clearInterval(badgeTimer);
    badgeTimer = undefined;
    if (registered && repo) {
      try { unregisterWorkspace(repo, id); }
      catch { /* Dead owners are pruned on the next registry access. */ }
    }
    registered = false;
  }

  pi.on("session_start", (_event, ctx) => {
    stop();
    target = undefined;
    try { repo = git(ctx.cwd, "rev-parse", "--show-toplevel"); }
    catch { repo = undefined; }
    try {
      target = sessionWorktree(ctx.cwd);
      if (target) {
        repo = target.sourceCwd;
        registerWorkspace(repo, {
          id, kind: "session", pid: process.pid, branch: target.branch, worktree: target.worktree,
          sourceBranch: target.sourceBranch ?? undefined, startedAt: Date.now(),
        });
        registered = true;
      }
    } catch (error) { ctx.ui.notify(`Workspace registration failed: ${errorText(error)}`, "error"); }
    badge(ctx);
    if (ctx.hasUI && repo) {
      badgeTimer = setInterval(() => { if (!busy) badge(ctx); }, 10_000);
      badgeTimer.unref();
    }
  });
  pi.on("session_shutdown", stop);

  pi.registerCommand("workspace", {
    description: "Show repository workspaces, claim scope, integrate or discard this session worktree",
    handler: async (args, ctx) => {
      const command = args.trim();
      try {
        if (!repo) throw new Error("No Git repository in this session.");
        if (!command || command === "status") {
          const entries = listActiveWorkspaces(repo);
          const lines = entries.map((entry) => {
            let changes: string;
            try { changes = git(entry.worktree, "status", "--short") || "clean"; }
            catch (error) { changes = `status unavailable: ${errorText(error)}`; }
            return `${entry.kind} ${entry.branch}${entry.id === id ? " (this session)" : ""} · PID ${entry.pid} (active)\n`
              + `  ${entry.worktree}${entry.scope ? `\n  Scope: ${entry.scope}` : ""}\n  ${changes.replaceAll("\n", "\n  ")}`;
          });
          ctx.ui.notify(lines.join("\n\n") || "No active workspaces in this repository.", "info");
          badge(ctx);
          return;
        }
        const claim = /^claim\s+(.+)$/s.exec(command);
        const integrate = command === "integrate";
        const force = /^discard\s+--force$/.test(command);
        if (!claim && !integrate && !force && command !== "discard") throw new Error(`Usage: ${USAGE}`);
        const worktree = target;
        if (!worktree || !registered) throw new Error("This command requires a registered session opened with agent --worktree.");
        if (busy) throw new Error("Workspace management is already in progress.");
        if (claim) {
          const scope = claim[1].replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
          if (!scope || [...scope].length > 160) throw new Error("Scope must contain 1–160 characters.");
          if (!updateWorkspaceScope(repo, id, scope)) throw new Error("This session is no longer registered.");
          ctx.ui.notify(`Workspace scope: ${scope}`, "info");
          return;
        }
        if (!ctx.isIdle()) throw new Error("Wait for the agent to finish before managing the workspace.");
        if (listActiveWorkspaces(repo).some((entry) => entry.id !== id && entry.worktree === worktree.worktree)) {
          throw new Error("Another active workspace owner is using this checkout.");
        }
        if (existsSync(worktree.worktree) && git(worktree.worktree, "symbolic-ref", "--quiet", "--short", "HEAD") !== worktree.branch) {
          throw new Error(`The session worktree must be on ${worktree.branch}.`);
        }
        busy = true;
        try {
          if (integrate) {
            const result = await integrateWorktreeBranch(worktree, { workspaceId: id });
            ctx.ui.notify([
              result.cleanupOnly ? `Cleaned up ${worktree.branch}.` : `Integrated ${worktree.branch} into ${worktree.sourceBranch}.`,
              result.gateMessage, result.cleanupWarning,
            ].filter(Boolean).join("\n"), result.cleanupWarning ? "warning" : "info");
          } else {
            const warning = await discardWorktreeBranch(worktree, force, { workspaceId: id });
            ctx.ui.notify([`Discarded ${worktree.branch}.`, warning].filter(Boolean).join("\n"), warning ? "warning" : "info");
          }
        } finally {
          busy = false;
          // Pi's cwd is fixed for a session. Do not keep accepting prompts once it is gone.
          if (!existsSync(worktree.worktree)) {
            stop();
            target = undefined;
            process.chdir(worktree.sourceCwd);
            ctx.ui.setStatus(STATUS, undefined);
            ctx.shutdown();
          }
        }
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
    },
  });
}
