import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_KEY } from './helpers.js';

const packageDir = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version: string };
let installDir: string;
let home: string;
let entry: string;

function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...extra };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: packageDir, stdio: 'pipe' });
  installDir = mkdtempSync(join(tmpdir(), 'oswiki-sign-bundle-'));
  home = join(installDir, 'home');
  mkdirSync(join(installDir, 'package', 'dist'), { recursive: true });
  mkdirSync(home);
  copyFileSync(join(packageDir, 'package.json'), join(installDir, 'package', 'package.json'));
  copyFileSync(join(packageDir, 'dist', 'index.js'), join(installDir, 'package', 'dist', 'index.js'));
  entry = join(installDir, 'package', 'dist', 'index.js');
}, 60_000);

afterAll(() => {
  if (installDir) rmSync(installDir, { recursive: true, force: true, maxRetries: 5 });
});

describe('bundled dist/index.js without node_modules', () => {
  it('prints the package version', () => {
    const run = spawnSync(process.execPath, [entry, '--version'], { cwd: installDir, env: isolatedEnv(), encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(version);
  });

  it('prints the setup help and refuses setup without a terminal', () => {
    const help = spawnSync(process.execPath, [entry, 'setup', '--help'], { cwd: installDir, env: isolatedEnv(), encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('oswiki-sign setup');
    const run = spawnSync(process.execPath, [entry, 'setup'], { cwd: installDir, env: isolatedEnv(), encoding: 'utf8', input: '' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('needs a terminal');
    expect(readdirSync(home)).toEqual([]);
  });

  it('exits with the setup message when no key is configured', () => {
    const run = spawnSync(process.execPath, [entry], { cwd: installDir, env: isolatedEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('OSWIKI_WALLET_KEY');
    expect(run.stderr).not.toContain('could not start');
    expect(run.stdout).toBe('');
  });

  it('answers an MCP handshake and lists the trading tools', async () => {
    const child = spawn(process.execPath, [entry], {
      cwd: installDir,
      env: isolatedEnv({ OSWIKI_WALLET_KEY: TEST_KEY, OSWIKI_DRY_RUN: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const tools = await new Promise<string[]>((resolveTools, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('no tools/list response')), 20_000);
      child.on('exit', code => reject(new Error(`exited with ${code}`)));
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (const line of buffer.split('\n').slice(0, -1)) {
          const message = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
          if (message.id === 2) {
            clearTimeout(timer);
            resolveTools((message.result?.tools ?? []).map(tool => tool.name));
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      });
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bundle-test', version: '0' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    }).finally(async () => {
      child.removeAllListeners('exit');
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    });
    expect(tools).toEqual(expect.arrayContaining(['wallet_status', 'preview_listing', 'preview_buy', 'execute']));
  }, 30_000);
});
