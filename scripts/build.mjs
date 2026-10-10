import { builtinModules } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(packageDir, 'dist', 'index.js');
rmSync(join(packageDir, 'dist'), { recursive: true, force: true });

const result = await build({
  absWorkingDir: packageDir,
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  legalComments: 'eof',
  charset: 'utf8',
  metafile: true,
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __oswikiSignCreateRequire } from 'node:module';\nconst require = __oswikiSignCreateRequire(import.meta.url);",
  },
});

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const external = Object.values(result.metafile.outputs)
  .flatMap(output => output.imports)
  .filter(entry => entry.external && !builtins.has(entry.path))
  .map(entry => entry.path);
if (external.length > 0) {
  console.error(`Bundle imports packages that are not bundled:\n${[...new Set(external)].join('\n')}`);
  process.exit(1);
}

const code = readFileSync(outfile, 'utf8');
if (!code.startsWith('#!/usr/bin/env node\n')) {
  console.error('dist/index.js must start with the node shebang.');
  process.exit(1);
}
console.log(`dist/index.js: ${(code.length / 1024).toFixed(0)} KiB, no runtime dependencies`);
