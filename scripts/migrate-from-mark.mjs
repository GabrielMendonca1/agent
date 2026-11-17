#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { migrateFromMark } from './lib/mark-migration.mjs';

try {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  const report = migrateFromMark({ dryRun: values['dry-run'] });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.dryRun ? 'Mark → Agent (dry-run; no profile changes)' : 'Mark → Agent');
    for (const [key, label] of Object.entries({ copied: 'Copiado / planejado', alreadyExisted: 'Já existia', skipped: 'Pulado', manual: 'Pendências manuais' })) {
      console.log(`${label}: ${report[key].length}`);
      for (const item of report[key]) console.log(`  ${item.path}: ${item.reason}`);
    }
  }
  if (report.manual.some(item => item.reason.startsWith('durable importer failed'))) process.exitCode = 1;
} catch (error) {
  // Paths and OS error codes are safe; never print JSON parse errors containing profile values.
  const message = error.code || (error.name === 'SyntaxError' ? 'Invalid settings JSON; nothing overwritten' : error.message);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: message }));
  else console.error(`Migration failed: ${message}`);
  process.exitCode = 1;
}
