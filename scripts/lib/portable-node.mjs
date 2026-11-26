import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const PORTABLE_NODE_VERSION = 'v24.22.3';
export const PORTABLE_NODE_BASE_URL = 'https://nodejs.org/dist';
// https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
// Keep the native bootstrap pins in install.sh and install.ps1 in sync.
export const PORTABLE_NODE_TARGETS = Object.freeze(Object.fromEntries(Object.entries({
  'darwin-arm64': ['darwin-arm64.tar.gz', 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd'],
  'darwin-x64': ['darwin-x64.tar.gz', '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7'],
  'linux-arm64': ['linux-arm64.tar.xz', '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c'],
  'linux-x64': ['linux-x64.tar.xz', '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb'],
  'win32-x64': ['win-x64.zip', 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'],
}).map(([target, [suffix, sha256]]) => [target, Object.freeze({ file: `node-${PORTABLE_NODE_VERSION}-${suffix}`, sha256 })])));

export function portableNodePath(store, { platform = process.platform, version = 'current' } = {}) {
  return join(store, 'node', version, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
}

export async function resolvePortableNode(store, options) {
  const bin = portableNodePath(store, options);
  try {
    if (!(await stat(bin)).isFile()) return undefined;
    await access(bin, constants.X_OK);
    return bin;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return undefined;
    throw error;
  }
}

export async function validatePortableNodeArchive(path, target = `${process.platform}-${process.arch}`) {
  const pin = Object.hasOwn(PORTABLE_NODE_TARGETS, target) && PORTABLE_NODE_TARGETS[target];
  if (!pin) throw Error(`Unsupported portable Node target: ${target}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== pin.sha256) throw Error(`Portable Node SHA-256 mismatch: ${pin.file}`);
}
