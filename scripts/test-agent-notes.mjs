#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policy from '../mark/juice/policy.mjs';
assert.equal(typeof policy.notesSection, 'function', 'notesSection existe');
assert.equal(policy.notesSection({ count: 0, ageDays: 9 }), '');
assert.equal(policy.notesSection({ count: 2, ageDays: 3 }), '<mark_notes>Mapa de notas do projeto em .mark/notes.md (2 linhas, atualizado há 3 dias): leia-o antes de explorar e responda pela nota quando ela cobrir a pergunta; quando a resposta for decidir algo, verifique no código.</mark_notes>');
const { readNotesMetadata, unmappedDocs } = await import('../mark/juice/notes.mjs');
const dir = mkdtempSync(join(tmpdir(), 'mark-notes-'));
try {
  const now = Date.now();
  assert.deepEqual(readNotesMetadata(dir, now), { count: 0, ageDays: 0 });
  mkdirSync(join(dir, '.mark'));
  const file = join(dir, '.mark/notes.md');
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
