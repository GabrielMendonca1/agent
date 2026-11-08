// Trusted expectations live outside the writable fixtures. Never run fixture-owned tests as the verdict.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { topicIds, records, recordAnswer, longScript } from './tasks.mjs';
const text = (d, f) => readFile(join(d, f), 'utf8');
const json = async (d, f) => JSON.parse(await text(d, f));
function probe(d, code) {
  execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict';\n" + code], { cwd: d, timeout: 5000, stdio: 'pipe', maxBuffer: 65536 });
}
export async function check(task, dir, { wallSeconds = 0 } = {}) {
  try {
    switch (task.id) {
      case 'invoice':
        probe(dir, `import {total} from './src/invoice.mjs';
          assert.equal(total([]), 0);
          assert.equal(total([{price:10,quantity:1}]),10);
          assert.equal(total([{price:0.1,quantity:3},{price:1.25,quantity:2}],0.1),2.52);
          assert.equal(total([{price:1.005,quantity:3}]),3.03);
          assert.equal(total([{price:2.99,quantity:5}],1),0);
          assert.equal(total([{price:0.33,quantity:3}],0.5),0.5);`);
        break;
      case 'topic-search':
        assert.deepEqual(await json(dir, 'matches.json'), topicIds.filter(i => i % 5 !== 0).map(i => `n${String(i).padStart(3, '0')}.md`));
        break;
      case 'rename':
        probe(dir, `import * as api from './src/index.mjs'; import {lookup} from './src/app.mjs';
          import * as users from './src/users.mjs';
          assert.equal('getUser' in api,false); assert.equal('getUser' in users,false);
          assert.equal(api.label,'getUser');
          for (const fn of [api.findUser,users.findUser,lookup]) {
            assert.equal(typeof fn,'function'); const u={id:7,name:'Ada'};
            assert.equal(fn([u],7),u); assert.equal(fn([u],8),null);
          }`);
        assert.equal(await text(dir, 'README.md'), 'Historical API: getUser.\n');
        break;
      case 'config-docs': {
        probe(dir, `import {load} from './src/config.mjs';
          assert.deepEqual(load({}),{port:8080});
          for (const s of ['1','65535','00080','8080']) assert.deepEqual(load({BENCH_PORT:s}),{port:Number(s)});
          for (const s of ['', '0','65536','-1','1.2','1e3',' 80','80 ','abc','+1','Infinity','0x50','80\\n']) assert.throws(()=>load({BENCH_PORT:s}));`);
        const docs = await text(dir, 'docs/config.md');
        for (const re of [/BENCH_PORT/, /8080/, /1\b/, /65535/, /reject|invalid|throw|error/i]) assert.match(docs, re);
        assert.deepEqual(await json(dir, 'settings.json'), { logLevel: 'info', retries: 3 });
        break;
      }
      case 'records':
        assert.deepEqual(await json(dir, 'summary.json'), recordAnswer);
        for (const row of records) assert.deepEqual(await json(dir, `records/${row.id}.json`), row);
        break;
      case 'long-command':
        assert.equal(await text(dir, 'batch.mjs'), longScript);
        assert.deepEqual(await json(dir, 'receipt.json'), { status: 'complete', batches: 8, checksum: 2997 });
        assert.equal(await text(dir, 'result.txt'), 'completed 8 batches; checksum 2997\n');
        assert.ok(wallSeconds >= 19.5, 'command must run for 20 seconds');
        break;
      default: throw new Error('Unknown task');
    }
    return { pass: true, reason: null };
  } catch (error) {
    // Do not copy arbitrary fixture content or child stderr into public reports.
    return { pass: false, reason: `${task.id}: ${error.code === 'ENOENT' ? 'required output missing' : 'trusted assertion failed'}` };
  }
}
