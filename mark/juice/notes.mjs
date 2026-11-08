import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Snapshot usado só no session_start, para não alterar o prefixo entre turnos. */
export function readNotesMetadata(cwd, now = Date.now()) {
  const file = join(cwd, '.mark/notes.md');
  try {
    const count = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim()).length;
    return { count, ageDays: Math.max(0, Math.floor((now - statSync(file).mtimeMs) / 86400000)) };
  } catch { return { count: 0, ageDays: 0 }; }
}

/** /notes lê o mapa atual, mas nunca atualiza o snapshot do system prompt. */
export function unmappedDocs(cwd) {
  let map = '';
  try { map = readFileSync(join(cwd, '.mark/notes.md'), 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const mapped = new Set(map.split(/\r?\n/).filter(line => line.includes(' — ')).map(line => line.split(' — ')[0].trim()));
  const docs = [];
  function walk(relative) {
    let entries;
    try { entries = readdirSync(join(cwd, relative), { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) docs.push(path);
    }
  }
  walk('docs');
  for (const path of ['STATUS.md', 'HISTORY.md']) {
    try { if (statSync(join(cwd, path)).isFile()) docs.push(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return docs.filter(path => !mapped.has(path)).sort();
}
