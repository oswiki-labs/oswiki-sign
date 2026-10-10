import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dist/index.js'];
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare'];

export function runNpm(args, options = {}) {
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/.test(cli)) return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
  const windows = process.platform === 'win32';
  return execFileSync(windows ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: windows, ...options });
}

/** @param {{ files: { path: string }[] }} pack */
export function packErrors(pack) {
  const errors = [];
  const files = pack.files.map(file => file.path.replaceAll('\\', '/'));
  for (const path of REQUIRED) {
    if (!files.includes(path)) errors.push(`missing ${path} (run the build first)`);
  }
  for (const path of files) {
    if (!REQUIRED.includes(path)) errors.push(`unexpected file ${path}`);
  }

  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  for (const field of DEPENDENCY_FIELDS) {
    const value = pkg[field];
    if (value !== undefined && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)) {
      errors.push(`package.json has ${field}: everything must be bundled into dist/index.js`);
    }
  }
  for (const script of INSTALL_SCRIPTS) {
    if (pkg.scripts?.[script] !== undefined) errors.push(`package.json has an install-time script "${script}"`);
  }
  return errors;
}

export function dryRunPack() {
  const [pack] = JSON.parse(runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageDir }));
  return pack;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pack = dryRunPack();
  const errors = packErrors(pack);
  if (errors.length > 0) {
    console.error(`Pack guard failed for ${pack.filename}:\n${errors.join('\n')}`);
    process.exit(1);
  }
  console.log(`${pack.filename}: ${pack.files.length} files, no dependencies, no install scripts`);
}
