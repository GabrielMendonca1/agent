import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const LIMITS = {
  processes: 12,
  sessionsPerAgent: 6,
  gitFiles: 10,
  journalEntries: 20,
  recordChars: 500,
  toolBytes: 16384,
  footerChars: 64,
  widgetLines: 10,
  slugName: 32,
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

const SECRET_PATTERNS = [
  /-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,4000}?(?:-----END[A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /hooks\.slack\.com\/services\/[A-Za-z0-9\/_-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/@:]{1,64}:[^\s/@]{1,64}@/g,
  /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,64}\.[A-Za-z]{2,24}\b/g,
  /[A-Za-z0-9_]{0,40}(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]{0,20}\s*[:=]\s*\S{1,200}/gi,
  /\b[0-9a-fA-F]{40,}\b/g,
  /\b[A-Za-z0-9+\/]{40,}={0,2}/g,
];

export function redact(text, options = {}) {
  const maxChars = options.maxChars ?? LIMITS.recordChars;
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(ANSI, "").replace(CONTROL, "");
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[REDACTED]");
  }
  out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{4,}/g, "   ").trim();
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return out;
}

export function safeInline(text, maxChars = LIMITS.recordChars) {
  let out = redact(text, { maxChars: LIMITS.recordChars });
  if (out.length === 0) return "";
  out = out.replace(/[\r\n\t]+/g, " ").replace(/`/g, "ˋ");
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return out;
}

const homeFormsCache = new Map();

function homeForms(home) {
  if (!home) return [];
  const cached = homeFormsCache.get(home);
  if (cached) return cached;
  const forms = [home];
  try {
    const real = fs.realpathSync(home);
    if (real && real !== home) forms.push(real);
  } catch {}
  homeFormsCache.set(home, forms);
  return forms;
}

export function homeRelative(target, home = homedir()) {
  if (typeof target !== "string" || target.length === 0) return "";
  for (const form of homeForms(home)) {
    if (target === form) return "~";
    if (target.startsWith(`${form}/`)) return `~${target.slice(form.length)}`;
  }
  return target;
}

export function projectSlug(root) {
  const base = path.basename(root || "") || "root";
  const name =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[-.]+/, "")
      .replace(/[-.]+$/, "")
      .slice(0, LIMITS.slugName)
      .replace(/[-.]+$/, "") || "project";
  const hash = createHash("sha256").update(String(root)).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

export function formatAge(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function deriveWarnings(snapshot) {
  const warnings = [];
  const runtimes = snapshot?.processes?.runtimes ?? [];
  const counts = new Map();
  for (const proc of runtimes) {
    if (!proc?.label) continue;
    counts.set(proc.label, (counts.get(proc.label) ?? 0) + 1);
  }
  for (const [label, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count >= 2) warnings.push(`${count}× ${label} no mesmo projeto`);
  }
  const claude = snapshot?.processes?.claude?.sessions ?? 0;
  if (claude >= 3) warnings.push(`${claude} sessoes claude com cwd neste projeto`);
  return warnings;
}

function gitBadge(git) {
  if (!git || git.unavailable) return null;
  const dirty = git.dirty?.total ?? 0;
  return `⎇${safeInline(git.branch ?? "?", LIMITS.footerChars)}${dirty > 0 ? "*" : ""}`;
}

export function renderFooter(snapshot) {
  if (!snapshot || snapshot.inert) return undefined;
  const parts = [];
  const badge = gitBadge(snapshot.git);
  if (badge) parts.push(badge);
  else parts.push(path.basename(snapshot.root || "") || "?");
  const claude = snapshot.processes?.claude?.sessions ?? 0;
  const pi = snapshot.processes?.pi?.sessions ?? 0;
  if (claude > 0) parts.push(`cc${claude}`);
  if (pi > 0) parts.push(`pi${pi}`);
  const ports = [];
  for (const proc of snapshot.processes?.runtimes ?? []) {
    for (const port of proc.ports ?? []) if (!ports.includes(port)) ports.push(port);
  }
  if (ports.length > 0) parts.push(ports.slice(0, 2).map((p) => `:${p}`).join(","));
  if (snapshot.processes?.unavailable) parts.push("ps?");
  if (parts.length === 0) return undefined;
  const line = `po ${parts.join(" · ")}`;
  return line.length > LIMITS.footerChars ? `${line.slice(0, LIMITS.footerChars - 1)}…` : line;
}

export function renderWidget(snapshot) {
  if (!snapshot || snapshot.inert) return undefined;
  const lines = [];
  lines.push(`project-operator · ${homeRelative(snapshot.root)}`);
  const git = snapshot.git;
  if (git && !git.unavailable) {
    const upstream = git.upstream ? ` · ↑${git.upstream.ahead} ↓${git.upstream.behind}` : "";
    lines.push(
      `git ${safeInline(git.branch ?? "?", 64)} @${safeInline(git.head ?? "?", 40)} · ${git.dirty?.total ?? 0} dirty (${git.dirty?.staged ?? 0}s/${git.dirty?.unstaged ?? 0}u/${git.dirty?.untracked ?? 0}n)${upstream}`,
    );
  } else {
    lines.push("git indisponivel");
  }
  const procs = snapshot.processes;
  if (procs?.unavailable) {
    lines.push("processos indisponiveis (ps/lsof)");
  } else {
    const helpers = procs?.claude?.helpers ?? 0;
    lines.push(
      `claude ${procs?.claude?.sessions ?? 0}${helpers ? ` (+${helpers} helpers)` : ""} · pi ${procs?.pi?.sessions ?? 0}`,
    );
    const runtimes = (procs?.runtimes ?? []).slice(0, 4);
    for (const proc of runtimes) {
      const ports = proc.ports?.length ? ` :${proc.ports.join(",:")}` : "";
      lines.push(`  ${proc.label} pid ${proc.pid}${proc.rel ? ` @${proc.rel}` : ""}${ports}`);
    }
  }
  const cc = snapshot.sessions?.claude ?? [];
  const pi = snapshot.sessions?.pi ?? [];
  lines.push(`transcripts cc ${cc.length} · pi ${pi.length}`);
  for (const warning of snapshot.warnings ?? []) lines.push(`! ${warning}`);
  return lines.slice(0, LIMITS.widgetLines);
}

export function snapshotFingerprint(snap) {
  const git = snap?.git;
  const procs = snap?.processes;
  const canonical = {
    root: snap?.root ?? null,
    slug: snap?.slug ?? null,
    git:
      !git || git.unavailable
        ? { unavailable: true, reason: git?.reason ?? null }
        : {
            unavailable: false,
            branch: git.branch ?? null,
            head: git.head ?? null,
            subject: git.subject ?? null,
            dirty: [
              git.dirty?.staged ?? 0,
              git.dirty?.unstaged ?? 0,
              git.dirty?.untracked ?? 0,
              git.dirty?.total ?? 0,
            ],
            upstream: git.upstream ? [git.upstream.ahead ?? 0, git.upstream.behind ?? 0] : null,
            stashes: git.stashes ?? 0,
            worktrees: (git.worktrees ?? []).map((wt) => String(wt)),
            files: (git.files ?? []).map((file) => `${file?.status ?? ""} ${file?.path ?? ""}`),
          },
    processes:
      !procs || procs.unavailable
        ? { unavailable: true, reason: procs?.reason ?? null }
        : {
            unavailable: false,
            claude: [procs.claude?.sessions ?? 0, procs.claude?.helpers ?? 0],
            pi: [procs.pi?.sessions ?? 0],
            runtimes: (procs.runtimes ?? []).map((proc) => [
              proc.pid ?? null,
              proc.ppid ?? null,
              proc.label ?? null,
              proc.rel ?? null,
              (proc.ports ?? []).map((port) => Number(port)),
            ]),
          },
    sessions: {
      claude: (snap?.sessions?.claude ?? []).map((entry) => [entry.name ?? "", entry.active === true, entry.current === true]),
      pi: (snap?.sessions?.pi ?? []).map((entry) => [entry.name ?? "", entry.active === true, entry.current === true]),
    },
    warnings: (snap?.warnings ?? []).map((warning) => String(warning)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

function sessionLine(entry) {
  return `- \`${entry.name}\` · ${formatAge(entry.ageMs)} · ${entry.sizeKb} KB${entry.active ? " · ativa" : ""}${entry.current ? " · atual" : ""}`;
}

export function renderOverview(snapshot, journalTail = [], meta = {}) {
  const at = new Date(snapshot.at ?? 0).toISOString();
  const git = snapshot.git;
  const procs = snapshot.processes;
  const lines = [];
  lines.push(`# Overview operacional — ${path.basename(snapshot.root || "")}`);
  lines.push("");
  lines.push(`- root: \`${homeRelative(snapshot.root)}\``);
  lines.push(`- slug: \`${snapshot.slug}\``);
  lines.push(`- snapshot: ${at}`);
  lines.push(`- gerado por: ${meta.renderedBy ?? "pi"}`);
  lines.push("");
  lines.push("## Git");
  lines.push("");
  if (git && !git.unavailable) {
    lines.push(`- branch: \`${safeInline(git.branch ?? "?", 120)}\` @ \`${safeInline(git.head ?? "?", 40)}\``);
    if (git.subject) lines.push(`- ultimo commit: ${safeInline(git.subject, 200)}`);
    lines.push(
      `- dirty: ${git.dirty?.total ?? 0} (staged ${git.dirty?.staged ?? 0}, unstaged ${git.dirty?.unstaged ?? 0}, untracked ${git.dirty?.untracked ?? 0})`,
    );
    if (git.upstream) lines.push(`- upstream: ahead ${git.upstream.ahead}, behind ${git.upstream.behind}`);
    else lines.push("- upstream: nenhum");
    if (git.stashes) lines.push(`- stashes: ${git.stashes}`);
    const files = (git.files ?? []).slice(0, LIMITS.gitFiles);
    if (files.length > 0) {
      lines.push("");
      for (const file of files) lines.push(`  - \`${safeInline(`${file.status} ${file.path}`, 200)}\``);
      if ((git.dirty?.total ?? 0) > files.length) lines.push(`  - … +${git.dirty.total - files.length}`);
    }
    if ((git.worktrees ?? []).length > 1) {
      lines.push("");
      lines.push(`- worktrees: ${git.worktrees.length}`);
      for (const wt of git.worktrees.slice(0, 5)) lines.push(`  - \`${safeInline(homeRelative(wt), 200)}\``);
    }
  } else {
    lines.push("- indisponivel (nao e repositorio git ou git ausente)");
  }
  lines.push("");
  lines.push("## Processos associados ao root");
  lines.push("");
  if (!procs || procs.unavailable) {
    lines.push("- indisponivel (ps/lsof ausente ou lento)");
  } else {
    lines.push(`- sessoes claude: ${procs.claude?.sessions ?? 0} (helpers ${procs.claude?.helpers ?? 0})`);
    lines.push(`- sessoes pi: ${procs.pi?.sessions ?? 0}`);
    const runtimes = (procs.runtimes ?? []).slice(0, LIMITS.processes);
    if (runtimes.length === 0) lines.push("- runtimes: nenhum");
    else {
      lines.push("- runtimes:");
      for (const proc of runtimes) {
        const ports = proc.ports?.length ? ` · portas ${proc.ports.join(",")}` : "";
        lines.push(`  - ${proc.label} · pid ${proc.pid} · ppid ${proc.ppid} · cwd \`${proc.rel || "."}\`${ports}`);
      }
      if (procs.truncated) lines.push("  - … lista truncada");
    }
  }
  lines.push("");
  lines.push("## Transcripts recentes");
  lines.push("");
  const cc = (snapshot.sessions?.claude ?? []).slice(0, LIMITS.sessionsPerAgent);
  const pi = (snapshot.sessions?.pi ?? []).slice(0, LIMITS.sessionsPerAgent);
  lines.push(`### claude (${cc.length})`);
  if (cc.length === 0) lines.push("- nenhum");
  for (const entry of cc) lines.push(sessionLine(entry));
  lines.push("");
  lines.push(`### pi (${pi.length})`);
  if (pi.length === 0) lines.push("- nenhum");
  for (const entry of pi) lines.push(sessionLine(entry));
  lines.push("");
  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("## Observacoes detectadas");
    lines.push("");
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  lines.push("## Intervencoes registradas");
  lines.push("");
  const tail = journalTail.slice(-LIMITS.journalEntries).reverse();
  if (tail.length === 0) lines.push("- nenhuma");
  for (const entry of tail) {
    const ts = new Date(entry.ts ?? 0).toISOString();
    lines.push(`- ${ts} · ${entry.kind ?? "note"} · ${entry.text ?? ""}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Arquivo derivado, reescrito a cada refresh. Fonte de verdade das intervencoes: `journal.jsonl`. Nao editar a mao.",
  );
  lines.push("O estado dinamico (git/processos) e a autoridade; este arquivo e apenas o ultimo snapshot.");
  return `${lines.join("\n")}\n`;
}
