// Fixed task version: bump when prompts, fixtures, references or expectations change.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { orchestrationTasks } from './orchestration.mjs';
export const version = 3;
export async function put(dir, name, text) {
  await mkdir(join(dir, name, '..'), { recursive: true });
  await writeFile(join(dir, name), text);
}
export const invoiceFixed = `export function total(lines, discount = 0) {
  const cents = lines.reduce((sum, l) => sum + Math.round((l.price + Number.EPSILON) * 100) * l.quantity, 0);
  return Math.round(cents * (1 - discount)) / 100;
}
`;
export const topicIds = Array.from({ length: 200 }, (_, i) => i).filter(i => i % 17 === 3);
export const records = Array.from({ length: 40 }, (_, i) => ({ id: `r${String(i).padStart(2, '0')}`, active: i % 3 !== 0, amount: i * 7 + 11, region: ['east', 'west'][i % 2] }));
export const recordAnswer = ['east', 'west'].map(region => {
  const rows = records.filter(r => r.active && r.region === region);
  return { region, count: rows.length, total: rows.reduce((s, r) => s + r.amount, 0) };
});
export const longScript = `import { writeFile } from 'node:fs/promises';
await new Promise(r => setTimeout(r, 20000));
await writeFile('receipt.json', JSON.stringify({ status: 'complete', batches: 8, checksum: 2997 }) + '\\n');
console.log('completed 8 batches; checksum 2997');
`;
const prefix = 'Work only in this repository. Do not delegate, use the network, or commit. ';
// Solo set: single-agent coding tasks; delegation is forbidden by the prefix.
const soloTasks = [
  {
    id: 'invoice', set: 'solo', timeoutSeconds: 180,
    prompt: prefix + 'Fix src/invoice.mjs total(lines, discount=0). Prices are nonnegative decimal dollars; round each unit price half-up to cents before multiplying by quantity (e.g. 1.005 becomes 101 cents, correcting binary floating-point artifacts), apply the fractional discount to the subtotal, then round the final cents half-up. Return dollars. Preserve exports and keep the existing smoke test green.',
    async fixture(d) {
      await put(d, 'src/invoice.mjs', 'export function total(lines, discount = 0) { return lines.reduce((s, l) => s + l.price, 0) - discount; }\n');
      await put(d, 'smoke.mjs', "import assert from 'node:assert/strict';\nimport {total} from './src/invoice.mjs';\nassert.equal(total([{price: 10, quantity: 1}]), 10);\n");
    },
    reference: d => put(d, 'src/invoice.mjs', invoiceFixed),
  },
  {
    id: 'topic-search', set: 'solo', timeoutSeconds: 180,
    prompt: prefix + 'Search all 200 notes in notes/. Write matches.json as a JSON array of filenames (without directory), sorted lexicographically, whose frontmatter has topic: payments AND status: active. Ignore mentions in body text.',
    async fixture(d) {
      for (let i = 0; i < 200; i++) await put(d, `notes/n${String(i).padStart(3, '0')}.md`, `---\ntopic: ${i % 17 === 3 ? 'payments' : 'shipping'}\nstatus: ${i % 5 === 0 ? 'archived' : 'active'}\n---\nNote ${i}. Related: topic: payments; status: active.\n`);
    },
    reference: d => put(d, 'matches.json', JSON.stringify(topicIds.filter(i => i % 5 !== 0).map(i => `n${String(i).padStart(3, '0')}.md`))),
  },
  {
    id: 'rename', set: 'solo', timeoutSeconds: 180,
    prompt: prefix + 'Rename the public export getUser to findUser across src/, including callers and barrel exports. Do not retain a getUser alias. Preserve behavior and leave README.md and string literals unchanged.',
    async fixture(d) {
      await put(d, 'src/users.mjs', "export function getUser(users, id) { return users.find(u => u.id === id) ?? null; }\nexport const label = 'getUser';\n");
      await put(d, 'src/index.mjs', "export { getUser, label } from './users.mjs';\n");
      await put(d, 'src/app.mjs', "import { getUser } from './index.mjs';\nexport const lookup = (users, id) => getUser(users, id);\n");
      await put(d, 'README.md', 'Historical API: getUser.\n');
    },
    async reference(d) {
      for (const f of ['users', 'index', 'app']) {
        const path = `src/${f}.mjs`;
        const text = await readFile(join(d, path), 'utf8');
        await put(d, path, text.replaceAll('getUser', 'findUser').replace("'findUser'", "'getUser'"));
      }
    },
  },
  {
    id: 'config-docs', set: 'solo', timeoutSeconds: 180,
    prompt: prefix + 'Implement BENCH_PORT in src/config.mjs: default 8080 only when unset; otherwise accept only decimal digits representing an integer 1..65535 (leading zeros allowed), and throw on invalid values including empty strings. load(env) returns {port}. Update docs/config.md to document the name, default, valid range, and rejection behavior. Preserve unrelated settings.',
    async fixture(d) {
      await put(d, 'src/config.mjs', 'export function load(env) { return { port: Number(env.BENCH_PORT) || 3000 }; }\n');
      await put(d, 'docs/config.md', '# Config\nPort defaults to 3000.\n');
      await put(d, 'settings.json', '{"logLevel":"info","retries":3}\n');
    },
    async reference(d) {
      await put(d, 'src/config.mjs', "export function load(env) {\n const s = env.BENCH_PORT;\n if (s === undefined) return {port: 8080};\n if (!/^\\d+$/.test(s) || Number(s) < 1 || Number(s) > 65535) throw new Error('Invalid BENCH_PORT');\n return {port: Number(s)};\n}\n");
      await put(d, 'docs/config.md', '# Config\nBENCH_PORT defaults to 8080 when unset. Accept decimal digits in range 1..65535. Reject invalid values (including empty strings) with an error.\n');
    },
  },
  {
    id: 'records', set: 'solo', timeoutSeconds: 180,
    prompt: prefix + 'Read all 40 JSON records in records/. Write summary.json as an array of {region,count,total}, sorted by region. Include only active:true rows, count rows and sum amount (integer cents) per region. Do not modify source records.',
    async fixture(d) { for (const row of records) await put(d, `records/${row.id}.json`, JSON.stringify(row) + '\n'); },
    reference: d => put(d, 'summary.json', JSON.stringify(recordAnswer)),
  },
  {
    id: 'long-command', set: 'solo', timeoutSeconds: 180,
    prompt: prefix + 'Run node batch.mjs to completion (it takes 20 seconds). Do not edit batch.mjs or fabricate the receipt. Read receipt.json after completion and write result.txt containing exactly: completed 8 batches; checksum 2997 followed by a newline.',
    fixture: d => put(d, 'batch.mjs', longScript),
    async reference(d) { execFileSync(process.execPath, ['batch.mjs'], { cwd: d, timeout: 30000 }); await put(d, 'result.txt', 'completed 8 batches; checksum 2997\n'); },
  },
];
export const tasks = [...soloTasks, ...orchestrationTasks];
// `--tasks` accepts ids and set names; `all` is every set.
export const sets = { solo: soloTasks.map(t => t.id), orchestration: orchestrationTasks.map(t => t.id), all: tasks.map(t => t.id) };
// Orchestration has high variance: 3 trials by default, reported by median.
export const defaultTrials = task => task.set === 'orchestration' ? 3 : 1;
