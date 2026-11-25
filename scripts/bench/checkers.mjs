// Trusted expectations live outside the writable fixtures. Never run fixture-owned tests as the verdict.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { topicIds, records, recordAnswer, longScript } from './tasks.mjs';
import { reconAnswer } from './orchestration.mjs';
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
      case 'recon':
        assert.deepEqual(await json(dir, 'answer.json'), reconAnswer);
        break;
      case 'parallel-writers':
        probe(dir, `import {slugify, parseDuration} from './src/index.mjs';
          const slug = [['Hello, World!','hello-world'],['  Crème Brûlée  ','creme-brulee'],['---','untitled'],['','untitled'],['ÀÉÎ õü 42','aei-ou-42'],
            [42,'42'],['a'.repeat(47)+' b','a'.repeat(47)],['x'.repeat(60),'x'.repeat(48)],['Ünïcödé__and--dashes','unicode-and-dashes']];
          for (const [i,o] of slug) assert.equal(slugify(i),o,String(i));
          const ok = [['1h30m',5400],['45s',45],['2h5s',7205],['0s',0],['90m',5400],['1h1m1s',3661],['01m',60]];
          for (const [i,o] of ok) assert.equal(parseDuration(i),o,i);
          for (const bad of ['','1m1h','1h1h','1.5h','-1s','+1s',' 1h','1h ','1d','h','1 h','5'])
            assert.throws(()=>parseDuration(bad),SyntaxError,JSON.stringify(bad));`);
        break;
      case 'implement-review':
        probe(dir, `import {paginate} from './src/paginate.mjs'; import {firstPage} from './src/legacy-report.mjs';
          const rows = Array.from({length:45},(_, i)=>i); const copy=[...rows];
          assert.deepEqual(paginate(rows), {items:rows.slice(0,20),page:1,perPage:20,totalItems:45,totalPages:3});
          assert.deepEqual(paginate(rows,{page:3,perPage:20}).items, rows.slice(40));
          assert.deepEqual(paginate(rows,{page:9}).items, []); assert.equal(paginate(rows,{page:9}).page, 9);
          assert.equal(paginate([]).totalPages, 1);
          const big = paginate(Array.from({length:250},(_, i)=>i),{perPage:500}); assert.equal(big.perPage,100); assert.equal(big.items.length,100); assert.equal(big.totalPages,3);
          for (const o of [{page:1.5},{perPage:'10'},{page:NaN},{size:2.5}]) assert.throws(()=>paginate(rows,o),TypeError);
          for (const o of [{page:0},{perPage:0},{size:-1}]) assert.throws(()=>paginate(rows,o),RangeError);
          const all = paginate(rows,{perPage:100}); assert.notEqual(all.items, rows); assert.deepEqual(rows, copy);
          // Planted compatibility requirement: v1 callers pass size.
          assert.deepEqual(paginate(rows,{page:2,size:10}).items, rows.slice(10,20));
          assert.equal(paginate(rows,{size:10}).totalPages, 5);
          assert.equal(paginate(rows,{size:1000}).perPage, 100);
          assert.equal(paginate(rows,{size:5,perPage:7}).perPage, 7);
          assert.deepEqual(firstPage(rows), rows.slice(0,10));`);
        break;
      case 'review-fix':
        probe(dir, `import {parseCsv} from './src/csv.mjs';
          const ok = [['',[]],['a',[['a']]],['a,b\\nc,d',[['a','b'],['c','d']]],['a,b\\r\\nc,d\\r\\n',[['a','b'],['c','d']]],
            ['a,,b',[['a','','b']]],['""',[['']]],[',',[['','']]],['"x, y",z',[['x, y','z']]],['"he said ""hi"""',[['he said "hi"']]],
            ['"line1\\nline2",b\\n',[['line1\\nline2','b']]],['"a\\r\\nb"',[['a\\r\\nb']]],['a\\n\\nb',[['a'],[''],['b']]],[' a , b ',[[' a ',' b ']]],['a\\n\\n',[['a'],['']]]];
          for (const [i,o] of ok) assert.deepEqual(parseCsv(i),o,JSON.stringify(i));
          for (const bad of ['"abc','a"b','"a"b','x,"y" ,z','"a""']) assert.throws(()=>parseCsv(bad),SyntaxError,JSON.stringify(bad));`);
        break;
      default: throw new Error('Unknown task');
    }
    return { pass: true, reason: null };
  } catch (error) {
    // Do not copy arbitrary fixture content or child stderr into public reports.
    return { pass: false, reason: `${task.id}: ${error.code === 'ENOENT' ? 'required output missing' : 'trusted assertion failed'}` };
  }
}
