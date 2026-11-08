import process from "node:process";
import { detectRoot, snapshot } from "./collect.mjs";
import { projectSlug, renderFooter, renderOverview } from "./render.mjs";
import { appendRecord, ensureDir, readTail, sidecarPaths, stateBaseDir, writeMetadata, writeOverview } from "./store.mjs";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const cwd = flag("root", process.cwd());
const baseDir = flag("base", stateBaseDir());
const note = flag("note", "");

const detected = await detectRoot(cwd);
if (detected.inert) {
  console.log(JSON.stringify({ inert: true, root: detected.root }, null, 2));
  process.exit(0);
}

const paths = sidecarPaths(projectSlug(detected.root), baseDir);
await ensureDir(paths.dir, paths.baseDir);
if (note) await appendRecord(paths, { kind: "note", session: `cli:${process.pid}`, text: note });

const snap = await snapshot(detected.root, { force: true });
const tail = await readTail(paths);
await writeOverview(paths, renderOverview(snap, tail, { renderedBy: `cli:${process.pid}` }));
await writeMetadata(paths, {
  root: snap.root,
  slug: snap.slug,
  updatedAt: new Date(snap.at).toISOString(),
  updatedBy: `cli:${process.pid}`,
  schema: 1,
});

console.log(
  JSON.stringify(
    {
      root: snap.root,
      isRepo: detected.isRepo,
      slug: snap.slug,
      dir: paths.dir,
      footer: renderFooter(snap),
      git: snap.git?.unavailable ? "unavailable" : { branch: snap.git.branch, dirty: snap.git.dirty.total },
      processes: snap.processes?.unavailable
        ? "unavailable"
        : { claude: snap.processes.claude, pi: snap.processes.pi, runtimes: snap.processes.runtimes.length },
      transcripts: { claude: snap.sessions.claude.length, pi: snap.sessions.pi.length },
      warnings: snap.warnings,
    },
    null,
    2,
  ),
);
