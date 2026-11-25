// Orchestration set: tasks that must be delegated to subagents. The fixture verdict lives in
// checkers.mjs; the delegation verdict below reads only the sanitized job summaries (children.mjs).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Own copy of tasks.mjs put(): importing it back would make the module graph circular.
async function put(dir, name, text) {
  await mkdir(join(dir, name, '..'), { recursive: true });
  await writeFile(join(dir, name), text);
}

const prefix = 'Work only in this repository. Do not use the network or commit. You are the orchestrator: delegate the work with the subagent tool as instructed below, wait for the results, integrate any worktree changes into this checkout, and verify the final state yourself before finishing. ';

// ---------- recon: large fixture, answer file ----------
export const reconPackages = ['accounts', 'audit', 'billing', 'cart', 'catalog', 'checkout', 'coupons', 'emails', 'export', 'fraud', 'gifts', 'inventory', 'invoices', 'ledger', 'loyalty', 'orders', 'partners', 'payouts', 'refunds', 'reports', 'search', 'shipping', 'subscriptions', 'taxes'];
const reconFiles = () => reconPackages.flatMap((pkg, p) => Array.from({ length: 20 }, (_, f) => ({ path: `src/${pkg}/m${String(f).padStart(2, '0')}.mjs`, pkg, n: p * 20 + f })))
  .filter(x => x.path !== 'src/billing/m00.mjs' && x.path !== 'src/billing/m01.mjs');
// Deterministic scatter over ~480 modules: real calls through three import shapes plus look-alike traps.
function reconKind(n) {
  const h = (n * 37 + 11) % 97;
  return h < 3 ? 'direct' : h < 5 ? 'alias' : h < 7 ? 'reexport' : h < 9 ? 'unused' : h < 12 ? 'comment' : h < 14 ? 'string' : h < 16 ? 'shadow' : 'noise';
}
function reconSource(kind, n) {
  const legacy = "'../billing/m00.mjs'", barrel = "'../billing/m01.mjs'";
  switch (kind) {
    case 'direct': return `import { legacyCharge } from ${legacy};\nexport function run${n}(order) {\n  const amount = order.total * 100;\n  return legacyCharge(order.customer, amount);\n}\n`;
    case 'alias': return `import { legacyCharge as pay, chargeV2 } from ${legacy};\nexport const run${n} = (order, fast) => fast ? chargeV2(order.customer, order.total) : pay(order.customer, order.total);\n`;
    case 'reexport': return `import { charge } from ${barrel};\nexport async function run${n}(o) { return charge(o.customer, o.total); }\n`;
    case 'unused': return `import { legacyCharge, chargeV2 } from ${legacy};\n// legacyCharge stays imported for a planned rollback.\nexport const run${n} = o => chargeV2(o.customer, o.total);\n`;
    case 'comment': return `import { chargeV2 } from ${legacy};\n// Migrated from legacyCharge(customer, amount) in 2024.\nexport const run${n} = o => chargeV2(o.customer, o.total);\n`;
    case 'string': return `export const metric${n} = 'legacyCharge(calls)';\nexport const run${n} = () => metric${n}.length;\n`;
    case 'shadow': return `const legacyCharge = (c, a) => ({ c, a, dryRun: true });\nexport const run${n} = o => legacyCharge(o.customer, o.total);\n`;
    default: return `export function run${n}(input) {\n  return { id: ${n}, size: Array.isArray(input) ? input.length : 0 };\n}\n`;
  }
}
export const reconAnswer = reconFiles().filter(f => ['direct', 'alias', 'reexport'].includes(reconKind(f.n))).map(f => f.path).sort();

// ---------- parallel writers ----------
export const slugifyRef = `export function slugify(input) {
  const s = String(input).normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = s.slice(0, 48).replace(/-+$/, '');
  return cut || 'untitled';
}
`;
export const durationRef = `export function parseDuration(input) {
  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(input);
  if (typeof input !== 'string' || !input || !m) throw new SyntaxError('Invalid duration');
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
`;

// ---------- implement + review, planted requirement ----------
const paginateSpec = `# paginate(items, options)

Implement \`paginate\` in src/paginate.mjs. It returns \`{ items, page, perPage, totalItems, totalPages }\`.

1. \`options\` may be omitted. \`page\` defaults to 1 and \`perPage\` defaults to 20.
2. \`page\` and \`perPage\` must be integers; any other value throws a TypeError.
3. \`page\` below 1 throws a RangeError. \`perPage\` below 1 throws a RangeError.
4. \`perPage\` above 100 behaves as 100 and the returned \`perPage\` is 100.
5. \`totalPages\` is \`Math.ceil(totalItems / perPage)\`, but never less than 1.
6. A page past the last one returns an empty \`items\` array; it is not an error.
7. Never mutate the input array; \`items\` is always a new array.

## Compatibility

Version 1 callers (see src/legacy-report.mjs) pass the page size as \`options.size\`. When \`perPage\` is absent, \`size\` is used with the same validation and clamping. When both are present, \`perPage\` wins.
`;
export const paginateRef = `export function paginate(items, options = {}) {
  let { page = 1, perPage } = options;
  if (perPage === undefined) perPage = options.size === undefined ? 20 : options.size;
  if (!Number.isInteger(page) || !Number.isInteger(perPage)) throw new TypeError('page and perPage must be integers');
  if (page < 1 || perPage < 1) throw new RangeError('page and perPage must be >= 1');
  perPage = Math.min(perPage, 100);
  const totalItems = items.length;
  return { items: items.slice((page - 1) * perPage, page * perPage), page, perPage, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / perPage)) };
}
`;

// ---------- review, then follow-up fix by the same worker ----------
const csvSpec = `# parseCsv(text)

Implement \`parseCsv\` in src/csv.mjs. It returns an array of records; each record is an array of strings.

- Fields are separated by commas. Records are separated by \\n or \\r\\n.
- A field may be wrapped in double quotes. Inside quotes, commas, \\n and \\r\\n are literal, and \`""\` is one literal quote.
- Empty fields are kept: \`a,,b\` is \`["a", "", "b"]\`; \`""\` is one empty field.
- An empty line in the middle is one record with one empty field.
- A single trailing record separator at the end of the text does not create an extra record.
- The empty string returns \`[]\`.
- An unterminated quoted field throws a SyntaxError. A quote character inside an unquoted field, or any character between a closing quote and the next separator, also throws a SyntaxError.
- Whitespace is never trimmed.
`;
export const csvRef = `export function parseCsv(text) {
  if (text === '') return [];
  const rows = [];
  let row = [], field = '', i = 0, quoted = false, closed = false;
  const endField = () => { row.push(field); field = ''; quoted = false; closed = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted && !closed) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        closed = true; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\\n' || (c === '\\r' && text[i + 1] === '\\n')) {
      i += c === '\\r' ? 2 : 1;
      endRow();
      if (i === text.length) return rows;
      continue;
    }
    if (closed) throw new SyntaxError('Unexpected character after closing quote');
    if (c === '"') {
      if (field !== '') throw new SyntaxError('Quote inside unquoted field');
      quoted = true; i++; continue;
    }
    field += c; i++;
  }
  if (quoted && !closed) throw new SyntaxError('Unterminated quoted field');
  endRow();
  return rows;
}
`;

// ---------- delegation predicates over sanitized jobs ----------
// Tasks in creation order; tasks of one job keep their declared order.
const sequence = jobs => [...jobs].sort((a, b) => a.createdAt - b.createdAt).flatMap(j => j.tasks.map(t => ({ ...t, job: j })));
const started = t => t.state && t.state !== 'not_run';
function subsequence(tasks, agents) {
  let at = 0;
  for (const t of tasks) if (at < agents.length && t.agent === agents[at] && started(t)) at++;
  return at === agents.length;
}
const overlap = (a, b) => a.createdAt < (b.finishedAt ?? Infinity) && b.createdAt < (a.finishedAt ?? Infinity);

export const orchestrationTasks = [
  {
    id: 'recon', set: 'orchestration', timeoutSeconds: 900,
    prompt: prefix + 'Delegate the search to a scout subagent; do not search the source tree yourself. Question: which modules under src/ call the function legacyCharge defined in src/billing/m00.mjs? Count a module when it calls that function under any local name, including through an import alias or through the re-export in src/billing/m01.mjs. Do not count src/billing/m00.mjs or src/billing/m01.mjs, modules that only import it without calling it, mentions in comments or strings, or unrelated local functions with the same name. Write answer.json at the repository root as a JSON array of repository-relative paths, sorted lexicographically.',
    async fixture(d) {
      await put(d, 'src/billing/m00.mjs', 'export function legacyCharge(customer, amount) { return { customer, amount, gateway: "v1" }; }\nexport function chargeV2(customer, amount) { return { customer, amount, gateway: "v2" }; }\n');
      await put(d, 'src/billing/m01.mjs', "export { legacyCharge as charge } from './m00.mjs';\n");
      for (const f of reconFiles()) await put(d, f.path, reconSource(reconKind(f.n), f.n));
      await put(d, 'README.md', '# Store\n\nModules live under src/<package>/. Billing entry points: src/billing/m00.mjs and the barrel src/billing/m01.mjs.\n');
    },
    reference: d => put(d, 'answer.json', JSON.stringify(reconAnswer, null, 2) + '\n'),
    delegation: jobs => sequence(jobs).some(t => t.agent === 'scout' && started(t)) ? null : 'no scout subagent ran',
  },
  {
    id: 'parallel-writers', set: 'orchestration', timeoutSeconds: 900,
    prompt: prefix + 'Make two independent changes with two worker subagents running in parallel (one worker per change, launched together), not sequentially and not by yourself. (1) In src/slug.mjs implement slugify(input): convert to string, Unicode NFKD, remove combining diacritical marks, lowercase, replace every run of characters other than a-z and 0-9 with one "-", strip leading and trailing "-", truncate to at most 48 characters and strip any "-" left at the end; return "untitled" if the result is empty. (2) In src/duration.mjs implement parseDuration(input): input is a string of up to three parts in the order hours, minutes, seconds, each a non-negative decimal integer followed by h, m or s, with each unit at most once and no spaces (e.g. "1h30m", "45s", "2h5s", "0s"); return the total in seconds; throw a SyntaxError for the empty string, units out of order, repeated units, decimals, signs, spaces or unknown units. Keep the existing exports and files otherwise unchanged.',
    async fixture(d) {
      await put(d, 'src/slug.mjs', "export function slugify(input) {\n  throw new Error('not implemented');\n}\n");
      await put(d, 'src/duration.mjs', "export function parseDuration(input) {\n  throw new Error('not implemented');\n}\n");
      await put(d, 'src/index.mjs', "export { slugify } from './slug.mjs';\nexport { parseDuration } from './duration.mjs';\n");
    },
    async reference(d) { await put(d, 'src/slug.mjs', slugifyRef); await put(d, 'src/duration.mjs', durationRef); },
    delegation(jobs) {
      const workers = jobs.filter(j => j.tasks.some(t => t.agent === 'worker' && started(t)));
      if (jobs.some(j => j.mode === 'parallel' && j.tasks.filter(t => t.agent === 'worker' && started(t)).length >= 2)) return null;
      return workers.some((a, i) => workers.slice(i + 1).some(b => overlap(a, b))) ? null : 'two worker subagents did not run in parallel';
    },
  },
  {
    id: 'implement-review', set: 'orchestration', timeoutSeconds: 900,
    prompt: prefix + 'Have a worker subagent implement src/paginate.mjs according to SPEC.md. After it finishes, have a reviewer subagent review the change against every requirement in SPEC.md, and get any confirmed finding fixed before you finish.',
    async fixture(d) {
      await put(d, 'SPEC.md', paginateSpec);
      await put(d, 'src/paginate.mjs', "export function paginate(items, options = {}) {\n  throw new Error('not implemented');\n}\n");
      await put(d, 'src/legacy-report.mjs', "import { paginate } from './paginate.mjs';\nexport const firstPage = rows => paginate(rows, { page: 1, size: 10 }).items;\n");
    },
    reference: d => put(d, 'src/paginate.mjs', paginateRef),
    delegation: jobs => subsequence(sequence(jobs), ['worker', 'reviewer']) ? null : 'no worker followed by a reviewer',
  },
  {
    id: 'review-fix', set: 'orchestration', timeoutSeconds: 1200,
    prompt: prefix + 'Run this cycle: (1) a worker subagent implements src/csv.mjs according to SPEC.md; (2) a reviewer subagent reviews that work against SPEC.md and reports findings; (3) send the reviewer findings back to the worker that did the work, continuing that same worker if the subagent tool allows it, otherwise launching a worker with the previous worker result and the findings, so it fixes them. Step 3 is mandatory even if the review finds nothing (the worker then confirms). Finish after verifying the result.',
    async fixture(d) {
      await put(d, 'SPEC.md', csvSpec);
      await put(d, 'src/csv.mjs', "export function parseCsv(text) {\n  return text.split('\\n').map(line => line.split(','));\n}\n");
    },
    reference: d => put(d, 'src/csv.mjs', csvRef),
    delegation: jobs => subsequence(sequence(jobs), ['worker', 'reviewer', 'worker']) ? null : 'no worker -> reviewer -> worker cycle',
  },
];
