// `node --import` hook for extension tests: resolves extensionless relative imports the way the
// host's bundler does, and `@earendil-works/*` plus the SDK's own deps (typebox…) against the
// installed pi. Shared by the test processes `node --test` forks.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const piRoot = process.env.AGENT_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent');

function packageEntry(pkg) {
  if (!existsSync(join(pkg, 'package.json'))) return undefined;
  const entry = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  const dot = entry.exports?.['.'];
  const main = typeof dot === 'string' ? dot : (dot?.import?.default ?? dot?.import ?? dot?.default ?? entry.module ?? entry.main ?? 'index.js');
  const file = join(pkg, typeof main === 'string' ? main : 'index.js');
  return existsSync(file) ? pathToFileURL(file).href : undefined;
}

// Node strips types only; extensions also use parameter properties/enums, so .ts goes through the SDK's esbuild.
const esbuild = createRequire(join(piRoot, 'package.json'))('esbuild');

registerHooks({
  load(url, context, next) {
    if (!url.startsWith('file:') || !url.split('?')[0].endsWith('.ts')) return next(url, context);
    const source = readFileSync(fileURLToPath(url.split('?')[0]), 'utf8');
    const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'node22', sourcefile: url });
    return { format: 'module', source: code, shortCircuit: true };
  },
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier.split('?')[0]) && context.parentURL?.split('?')[0].endsWith('.ts')) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('file:') && !specifier.includes('/', specifier.startsWith('@') ? specifier.indexOf('/') + 1 : 0)) {
      try {
        return next(specifier, context);
      } catch {
        const pkg = specifier === '@earendil-works/pi-coding-agent' ? piRoot : join(piRoot, 'node_modules', specifier);
        const url = packageEntry(pkg);
        if (url) return next(url, context);
        throw new Error(`extension-test-loader: ${specifier} not found under ${piRoot}`);
      }
    }
    return next(specifier, context);
  },
});
