import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claudeAddArgs,
  claudeDesktopConfigPath,
  claudeInvocation,
  createTerminalPrompter,
  DENY_RULES,
  keyFilePath,
  runSetup,
  type Exec,
  type SetupDeps,
} from '../src/setup.js';
import { TEST_KEY } from './helpers.js';

const VERSION = '0.1.1';
const PKG = `@oswikixyz/sign@${VERSION}`;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oswiki-setup-'));
  const home = join(root, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

interface Harness {
  deps: SetupDeps;
  exec: ReturnType<typeof vi.fn<Exec>>;
  output: () => string;
  questions: string[];
  keys: Hex[];
}

function harness(answers: string[], options: { secrets?: string[]; platform?: NodeJS.Platform; path?: string; isTTY?: boolean } = {}): Harness {
  const lines: string[] = [];
  const questions: string[] = [];
  const keys: Hex[] = [];
  const secrets = [...(options.secrets ?? [])];
  const queue = [...answers];
  const exec = vi.fn<Exec>(() => '');
  const deps: SetupDeps = {
    io: {
      print: text => lines.push(text),
      ask: async (question) => {
        questions.push(question);
        lines.push(question);
        const answer = queue.shift();
        if (answer === undefined) throw new Error(`unexpected question: ${question}`);
        return answer;
      },
      askSecret: async (question) => {
        lines.push(question);
        const secret = secrets.shift();
        if (secret === undefined) throw new Error('unexpected secret prompt');
        return secret;
      },
    },
    isTTY: options.isTTY ?? true,
    platform: options.platform ?? process.platform,
    env: { PATH: options.path ?? join(root, 'empty-bin'), USERNAME: 'tester', SystemRoot: 'C:\\Windows', APPDATA: process.env.APPDATA },
    home: homedir(),
    version: VERSION,
    exec,
    now: () => new Date('2026-10-11T12:00:00.000Z'),
    generateKey: () => {
      const key = generatePrivateKey();
      keys.push(key);
      return key;
    },
  };
  return { deps, exec, output: () => lines.join('\n'), questions, keys };
}

function expectNoKey(text: string, key: string): void {
  const hex = key.replace(/^0x/, '');
  expect(text.toLowerCase()).not.toContain(hex.toLowerCase());
  expect(text.toLowerCase()).not.toContain(hex.slice(0, 16).toLowerCase());
}

function homeFile(...parts: string[]): string {
  return join(homedir(), ...parts);
}

describe('setup: create wallet', () => {
  it('writes the key file with owner-only access, prints only the address and pins the version', async () => {
    const h = harness(['', '', '', '', '', '', '', '4']);
    expect(await runSetup([], h.deps)).toBe(0);

    const key = h.keys[0]!;
    const keyFile = keyFilePath(homedir());
    expect(keyFile).toBe(homeFile('.oswiki-sign', 'key'));
    expect(readFileSync(keyFile, 'utf8')).toBe(`${key}\n`);
    if (process.platform === 'win32') {
      expect(h.exec).toHaveBeenCalledWith('C:\\Windows\\System32\\icacls.exe', [keyFile, '/inheritance:r', '/grant:r', 'tester:R']);
    } else {
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(homedir(), '.oswiki-sign')).mode & 0o777).toBe(0o700);
    }

    const out = h.output();
    expectNoKey(out, key);
    const address = privateKeyToAccount(key).address;
    expect(out).toContain(`Your new trading wallet: ${address}`);
    expect(out).toContain('Send the NFTs you want to trade and a little ETH (Ethereum) / APE (ApeChain) for gas to this address');
    expect(out).toContain(`"${PKG}"`);
    expect(out).toContain(JSON.stringify(keyFile));
    expect(out).toContain('"OSWIKI_DRY_RUN": "1"');
    expect(out).toContain('"OSWIKI_MAX_BUY_ETH": "0.05"');
    expect(out).toContain('"OSWIKI_MAX_BUY_APE": "50"');
    expect(h.questions.some(q => q.startsWith('Show the private key once') && q.endsWith('(y/N) '))).toBe(true);
    expect(h.questions.some(q => q.startsWith('Turn dry run on?') && q.endsWith('(Y/n) '))).toBe(true);
  });

  it('shows a new key only on explicit opt-in, once', async () => {
    const h = harness(['1', 'y', '', 'skip', 'skip', '0', '10', 'n', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out.split(h.keys[0]!).length - 1).toBe(1);
    expect(out).not.toContain('OSWIKI_MAX_BUY_ETH');
    expect(out).not.toContain('OSWIKI_MAX_BUY_APE');
    expect(out).toContain('"OSWIKI_DRY_RUN": "0"');
    expect(out).toContain('"OSWIKI_MIN_LIST_FLOOR_PCT": "0"');
  });

  it('re-asks invalid limits', async () => {
    const h = harness(['', '', '-1', '1e3', '0', '0.25', '', '150', '', '', '', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    expect(h.output()).toContain('"OSWIKI_MAX_BUY_ETH": "0.25"');
    expect(h.output()).toContain('Please enter a whole number from 0 to 100.');
  });
});

describe('setup: import', () => {
  it('validates the key at a hidden prompt and never echoes it', async () => {
    const bad = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const shortHex = 'ab'.repeat(31);
    const h = harness(['2', '', '', '', '', '', '', '4'], { secrets: [bad, shortHex, TEST_KEY.slice(2).toUpperCase()] });
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expectNoKey(out, TEST_KEY);
    expect(out).not.toContain(bad);
    expect(out).not.toContain(shortHex);
    expect(out).toContain(`This key belongs to ${privateKeyToAccount(TEST_KEY).address}.`);
    expect(readFileSync(keyFilePath(homedir()), 'utf8')).toBe(`${TEST_KEY.toLowerCase()}\n`);
    expect(h.keys).toEqual([]);
  });

  it('gives up after three invalid keys without writing anything', async () => {
    const h = harness(['2'], { secrets: ['x', 'y', 'z'] });
    expect(await runSetup([], h.deps)).toBe(1);
    expect(existsSync(keyFilePath(homedir()))).toBe(false);
  });

  it('stops when the derived address is not the expected wallet', async () => {
    const h = harness(['2', 'n'], { secrets: [TEST_KEY] });
    expect(await runSetup([], h.deps)).toBe(1);
    expect(existsSync(keyFilePath(homedir()))).toBe(false);
  });
});

describe('setup: existing key file', () => {
  function seedKey(): string {
    const keyFile = keyFilePath(homedir());
    mkdirSync(join(homedir(), '.oswiki-sign'), { recursive: true });
    writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o600 });
    return keyFile;
  }

  it('refuses to overwrite unless explicitly confirmed', async () => {
    const keyFile = seedKey();
    const h = harness(['n', '']);
    expect(await runSetup([], h.deps)).toBe(1);
    expect(readFileSync(keyFile, 'utf8')).toBe(`${TEST_KEY}\n`);
    expect(readdirSync(join(homedir(), '.oswiki-sign'))).toEqual(['key']);
    expect(h.questions.find(q => q.startsWith('Replace the existing key file?'))).toMatch(/\(y\/N\) $/);
    expectNoKey(h.output(), TEST_KEY);
  });

  it('keeps the existing wallet by default', async () => {
    const keyFile = seedKey();
    const h = harness(['', '', '', '', '', '', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    expect(readFileSync(keyFile, 'utf8')).toBe(`${TEST_KEY}\n`);
    expect(h.output()).toContain(privateKeyToAccount(TEST_KEY).address);
    expect(h.keys).toEqual([]);
  });

  it('backs the old key up with the same permissions when replacing', async () => {
    const keyFile = seedKey();
    const h = harness(['n', 'y', '1', '', '', '', '', '', '', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    const backup = `${keyFile}.bak-2026-10-11T12-00-00-000Z`;
    expect(readFileSync(backup, 'utf8')).toBe(`${TEST_KEY}\n`);
    expect(readFileSync(keyFile, 'utf8')).toBe(`${h.keys[0]}\n`);
    if (process.platform !== 'win32') expect(statSync(backup).mode & 0o777).toBe(0o600);
    expectNoKey(h.output(), TEST_KEY);
  });
});

describe('setup: client configs', () => {
  it('merges into the Cursor config, keeping other servers, after a backup', async () => {
    const path = homeFile('.cursor', 'mcp.json');
    mkdirSync(join(homedir(), '.cursor'));
    const original = JSON.stringify({ theme: 'x', mcpServers: { other: { command: 'other' }, 'oswiki-sign': { command: 'old' } } });
    writeFileSync(path, original);
    const h = harness(['', '', '', '', '', '', '', '2', '']);
    expect(await runSetup([], h.deps)).toBe(0);

    expect(readFileSync(`${path}.bak-2026-10-11T12-00-00-000Z`, 'utf8')).toBe(original);
    const text = readFileSync(path, 'utf8');
    expectNoKey(text, h.keys[0]!);
    const merged = JSON.parse(text) as { theme: string; mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };
    expect(merged.theme).toBe('x');
    expect(merged.mcpServers.other).toEqual({ command: 'other' });
    expect(merged.mcpServers['oswiki-sign']).toEqual({
      command: 'npx',
      args: ['-y', PKG],
      env: {
        OSWIKI_WALLET_KEY_FILE: keyFilePath(homedir()),
        OSWIKI_DRY_RUN: '1',
        OSWIKI_MAX_BUY_ETH: '0.05',
        OSWIKI_MAX_BUY_APE: '50',
        OSWIKI_MIN_LIST_FLOOR_PCT: '50',
        OSWIKI_MAX_TRADES_PER_DAY: '50',
      },
    });
  });

  it('creates the Claude Desktop config when missing and refuses to touch invalid JSON', async () => {
    const path = claudeDesktopConfigPath(process.platform, homedir(), process.env);
    const h = harness(['', '', '', '', '', '', '', '3', '']);
    expect(await runSetup([], h.deps)).toBe(0);
    expect(Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: object }).mcpServers)).toEqual(['oswiki-sign']);

    writeFileSync(path, '{ "mcpServers": { secret-token-123 ');
    const again = harness(['', '', '', '', '', '', '3']);
    expect(await runSetup([], again.deps)).toBe(1);
    expect(again.output()).toContain('is not valid JSON');
    expect(again.output()).not.toContain('secret-token-123');
    expect(readFileSync(path, 'utf8')).toBe('{ "mcpServers": { secret-token-123 ');
  });

  it('uses the per-platform Claude Desktop paths', () => {
    expect(claudeDesktopConfigPath('darwin', '/Users/a', {})).toBe(join('/Users/a', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(claudeDesktopConfigPath('win32', 'C:\\Users\\a', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' })).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(claudeDesktopConfigPath('linux', '/home/a', {})).toBe(join('/home/a', '.config', 'Claude', 'claude_desktop_config.json'));
  });
});

describe('setup: Claude Code', () => {
  function fakeClaude(): { bin: string; claude: string } {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const claude = join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
    writeFileSync(claude, '');
    return { bin, claude };
  }

  it('runs claude mcp add with the exact pinned args, replaces an existing entry and adds the deny rules', async () => {
    const { bin, claude } = fakeClaude();
    writeFileSync(homeFile('.claude.json'), JSON.stringify({ mcpServers: { 'oswiki-sign': { command: 'npx' } } }));
    mkdirSync(join(homedir(), '.claude'));
    const settingsPath = homeFile('.claude', 'settings.json');
    const originalSettings = JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['Read(./.env)', DENY_RULES[0]] } });
    writeFileSync(settingsPath, originalSettings);

    const h = harness(['', '', '0.5', '500', '', '', '', '1', '', ''], { path: bin });
    expect(await runSetup([], h.deps)).toBe(0);

    const keyFile = keyFilePath(homedir());
    const launcher = process.platform === 'win32' ? ['cmd', '/c', 'npx'] : ['npx'];
    const expectedAdd = [
      'mcp', 'add', '--scope', 'user', 'oswiki-sign',
      '-e', `OSWIKI_WALLET_KEY_FILE=${keyFile}`,
      '-e', 'OSWIKI_DRY_RUN=1',
      '-e', 'OSWIKI_MAX_BUY_ETH=0.5',
      '-e', 'OSWIKI_MAX_BUY_APE=500',
      '-e', 'OSWIKI_MIN_LIST_FLOOR_PCT=50',
      '-e', 'OSWIKI_MAX_TRADES_PER_DAY=50',
      '--', ...launcher, '-y', PKG,
    ];
    const calls = h.exec.mock.calls.filter(([file]) => file === claude);
    expect(calls).toEqual([
      [claude, ['mcp', 'remove', 'oswiki-sign', '--scope', 'user'], { windowsVerbatimArguments: false }],
      [claude, expectedAdd, { windowsVerbatimArguments: false }],
    ]);
    for (const [, args] of h.exec.mock.calls) expectNoKey(args.join(' '), h.keys[0]!);
    expectNoKey(h.output(), h.keys[0]!);

    expect(readFileSync(`${settingsPath}.bak-2026-10-11T12-00-00-000Z`, 'utf8')).toBe(originalSettings);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { model: string; permissions: { allow: string[]; deny: string[] } };
    expect(settings.model).toBe('x');
    expect(settings.permissions.allow).toEqual(['Bash(ls)']);
    expect(settings.permissions.deny).toEqual(['Read(./.env)', ...DENY_RULES]);
  });

  it('prints the exact command when claude is not installed', async () => {
    const h = harness(['', '', '', '', '', '', '', '1', 'n']);
    expect(await runSetup([], h.deps)).toBe(0);
    expect(h.exec.mock.calls.filter(([file]) => !file.endsWith('icacls.exe'))).toEqual([]);
    expect(h.output()).toContain('The claude command was not found. Run this yourself:');
    expect(h.output()).toContain(`claude mcp add --scope user oswiki-sign -e`);
    expect(h.output()).toContain(PKG);
    expect(existsSync(homeFile('.claude', 'settings.json'))).toBe(false);
  });

  it('builds the args for Windows with the cmd launcher', () => {
    expect(claudeAddArgs(VERSION, { OSWIKI_WALLET_KEY_FILE: 'C:\\Users\\a b\\.oswiki-sign\\key' }, 'win32')).toEqual([
      'mcp', 'add', '--scope', 'user', 'oswiki-sign', '-e', 'OSWIKI_WALLET_KEY_FILE=C:\\Users\\a b\\.oswiki-sign\\key', '--', 'cmd', '/c', 'npx', '-y', PKG,
    ]);
  });

  it('quotes every argument for a claude.cmd shim and refuses ones cmd would expand', () => {
    const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    expect(claudeInvocation('C:\\npm\\claude.cmd', ['mcp', 'add', 'A=C:\\Users\\a b\\key'], env)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\npm\\claude.cmd" "mcp" "add" "A=C:\\Users\\a b\\key""'],
      verbatim: true,
    });
    expect(claudeInvocation('C:\\npm\\claude.cmd', ['A=C:\\Users\\%PATH%\\key'], env)).toBeNull();
    expect(claudeInvocation('C:\\npm\\claude.cmd', ['A="x" & calc'], env)).toBeNull();
    expect(claudeInvocation('/usr/bin/claude', ['mcp'], env)).toEqual({ file: '/usr/bin/claude', args: ['mcp'], verbatim: false });
  });
});

describe('setup: entry checks', () => {
  it('refuses without a terminal', async () => {
    const h = harness([], { isTTY: false });
    expect(await runSetup([], h.deps)).toBe(1);
    expect(h.output()).toContain('needs a terminal');
    expect(existsSync(join(homedir(), '.oswiki-sign'))).toBe(false);
  });

  it('prints help, also without a terminal', async () => {
    const h = harness([], { isTTY: false });
    expect(await runSetup(['--help'], h.deps)).toBe(0);
    expect(h.output()).toContain('oswiki-sign setup');
  });

  it('refuses an unreadable version', async () => {
    const h = harness([]);
    h.deps.version = '0.0.0';
    expect(await runSetup([], h.deps)).toBe(1);
  });
});

describe('hidden input', () => {
  function fakeTty() {
    const input = new PassThrough() as PassThrough & { isRaw: boolean; isTTY: boolean; setRawMode: (raw: boolean) => void };
    input.isTTY = true;
    input.isRaw = false;
    const rawModes: boolean[] = [];
    input.setRawMode = (raw: boolean) => {
      rawModes.push(raw);
      input.isRaw = raw;
    };
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const prompter = createTerminalPrompter(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
    return { input, prompter, rawModes, written: () => written };
  }

  it('reads in raw mode, masks every character and restores the terminal', async () => {
    const tty = fakeTty();
    const pending = tty.prompter.askSecret('Private key: ');
    tty.input.write(TEST_KEY.slice(0, 20));
    tty.input.write(`${TEST_KEY.slice(20)}x\u007f\r`);
    expect(await pending).toBe(TEST_KEY);
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.written()).toBe(`Private key: ${'*'.repeat(TEST_KEY.length + 1)}\b \b\n`);
  });

  it('cancels on Ctrl-C', async () => {
    const tty = fakeTty();
    const pending = tty.prompter.askSecret('Private key: ');
    tty.input.write('0xab\u0003');
    await expect(pending).rejects.toThrow('Setup cancelled.');
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.written()).not.toContain('ab');
  });
});
