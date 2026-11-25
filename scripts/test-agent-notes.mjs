#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policy from '../agent/core/policy.mjs';
assert.equal(typeof policy.notesSection, 'function', 'notesSection existe');
assert.equal(policy.notesSection({ count: 0, ageDays: 9 }), '');
assert.equal(policy.notesSection({ count: 2, ageDays: 3 }), '<agent_notes>Project notes map at .agent/notes.md (2 lines, updated 3 days ago): read it before exploring and answer from the note when it covers the question; when the answer decides something, verify it in the code.</agent_notes>');
const { readNotesMetadata, unmappedDocs } = await import('../agent/core/notes.mjs');
const dir = mkdtempSync(join(tmpdir(), 'agent-notes-'));
try {
  const now = Date.now();
  assert.deepEqual(readNotesMetadata(dir, now), { count: 0, ageDays: 0 });
  mkdirSync(join(dir, '.agent'));
  const file = join(dir, '.agent/notes.md');
  writeFileSync(file, '\n  \r\ndocs/a.md — nota privada\r\n\tdocs/b.md — outra\n');
  utimesSync(file, new Date(now - 3.5 * 86400000), new Date(now - 3.5 * 86400000));
  assert.deepEqual(readNotesMetadata(dir, now), { count: 2, ageDays: 3 });
  utimesSync(file, new Date(now + 86400000), new Date(now + 86400000));
  assert.deepEqual(readNotesMetadata(dir, now), { count: 2, ageDays: 0 });
  mkdirSync(join(dir, 'docs/nested'), { recursive: true });
  for (const path of ['docs/a.md', 'docs/b.md', 'docs/ab.md', 'docs/nested/c.md', 'docs/decisions.md', 'STATUS.md', 'HISTORY.md', 'docs/no.txt']) writeFileSync(join(dir, path), 'doc');
  assert.deepEqual(unmappedDocs(dir), ['HISTORY.md', 'STATUS.md', 'docs/ab.md', 'docs/decisions.md', 'docs/nested/c.md']);
  writeFileSync(file, '');
  assert.deepEqual(readNotesMetadata(dir, now), { count: 0, ageDays: 0 });
  assert.equal(unmappedDocs(dir).length, 7);
  console.log('PASS notes: seção, contagem, idade e docs sem linha exata');
} finally { rmSync(dir, { recursive: true, force: true }); }
