import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkOnly = process.argv.includes('--check');
const packagePath = resolve(root, 'package.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const version = String(packageJson.version || '').trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json 中的版本号无效：${version || '空'}`);
}

const updates = [
  {
    path: resolve(root, 'src-tauri/Cargo.toml'),
    transform: (text) => text.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("\s*)/, `$1${version}$2`)
  },
  {
    path: resolve(root, 'src-tauri/Cargo.lock'),
    transform: (text) => text.replace(/(name = "siren-records-cross-platform"\r?\nversion = ")[^"]+("\r?\n)/, `$1${version}$2`)
  },
  {
    path: resolve(root, 'src-tauri/tauri.conf.json'),
    transform: (text) => text.replace(/("version"\s*:\s*")[^"]+("\s*,)/, `$1${version}$2`)
  },
  {
    path: resolve(root, 'README.md'),
    transform: (text) => text.replace(/(<!-- app-version:start -->)v[^<]+(<!-- app-version:end -->)/, `$1v${version.replace(/\.0$/, '')}$2`)
  }
];

const changed = [];
for (const update of updates) {
  const current = await readFile(update.path, 'utf8');
  const next = update.transform(current);
  if (current !== next) {
    changed.push(update.path);
    if (!checkOnly) await writeFile(update.path, next, 'utf8');
  }
}

if (checkOnly && changed.length) {
  throw new Error(`版本文件未与 package.json 同步：\n${changed.join('\n')}`);
}

console.log(checkOnly ? `版本一致：v${version}` : `版本已同步：v${version}`);
