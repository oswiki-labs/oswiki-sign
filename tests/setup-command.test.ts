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
  NEVER_PASTE,
  box,
  useColor,
  runSetup,
  type Exec,
  type SetupDeps,
} from '../src/setup.js';
import type { FetchLike } from '../src/api.js';
import { loadWallet } from '../src/secret.js';
import { settingsFile, settingsMacKey, writeOverrides } from '../src/settings.js';
import { TEST_KEY } from './helpers.js';

const VERSION = '0.1.2';
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

function harness(answers: string[], options: { sendLimits?: string[]; secrets?: string[]; platform?: NodeJS.Platform; path?: string; isTTY?: boolean; color?: boolean; fetch?: FetchLike } = {}): Harness {
  const lines: string[] = [];
  const questions: string[] = [];
  const keys: Hex[] = [];
  const secrets = [...(options.secrets ?? [])];
  const queue = [...answers];
  const sendQueue = [...(options.sendLimits ?? [])];
  const exec = vi.fn<Exec>(() => '');
  const deps: SetupDeps = {
    io: {
      print: text => lines.push(text),
      ask: async (question) => {
        questions.push(question);
        lines.push(question);
        if (question.startsWith('Daily send limit')) return sendQueue.shift() ?? '';
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
    color: options.color ?? false,
    fetch: options.fetch ?? (async () => { throw new Error('offline'); }),
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
    const h = harness(['', '', '', '', '', '', '', '', '', '4']);
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
    expect(out).toContain('Your new trading wallet');
    expect(out).toContain(`| ${address}`);
    expect(out).toContain(`Key saved to ${keyFile} (only you can read it)`);
    expect(out).toContain(NEVER_PASTE);
    expect(out).not.toContain('\u001b[');
    expect(out).toContain(`"${PKG}"`);
    expect(out).toContain(JSON.stringify(keyFile));
    expect(out).toContain('"OSWIKI_DRY_RUN": "0"');
    expect(out).toContain('"OSWIKI_MAX_BUY_ETH": "0.05"');
    expect(out).toContain('"OSWIKI_MAX_BUY_APE": "50"');
    expect(h.questions).toContain('Back up the private key now? (y/N) - if you lose the key file, the wallet is gone ');
    expect(h.questions).toContain('Dry run (nothing is sent)? (y/N) ');
    expect(h.questions).toContain('1) Any  2) Only these  3) Any except these [1]: ');
    expect(h.questions).toContain('Your choice (y/N) ');
    expect(h.questions).toContain('1) Claude Code  2) Cursor  3) Claude Desktop  4) Print config [1]: ');
    for (const question of h.questions) expect(question.length, question).toBeLessThanOrEqual(90);
    expect(out).toContain('No = you approve each trade in a dialog (recommended)');
    expect(out).toContain('"OSWIKI_CONFIRM_MODE": "human"');
    expect(out).toMatch(/Done\. Wallet 0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4} · dry run off · dialog on · any collection/);
    expect(out).toContain('Never paste the private key into a chat.');
  });

  it('writes OSWIKI_CONFIRM_MODE=off only when the user lets the AI trade on its own', async () => {
    const h = harness(['', '', '', '', '', '', 'n', '', 'yes', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out).toContain('"OSWIKI_CONFIRM_MODE": "off"');
    expect(out).toContain('confirmation OFF - AI trades on its own within your limits');
  });

  it('leaves fund sending off unless a daily send limit is entered', async () => {
    const off = harness(['', '', '', '', '', '', '', '', '', '4']);
    expect(await runSetup([], off.deps)).toBe(0);
    expect(off.output()).not.toContain('OSWIKI_DAILY_MAX_SEND');
    expect(off.questions).toContain('Daily send limit, ETH + WETH (skip = off) [skip]: ');
  });

  it('writes a daily send limit when one is entered', async () => {
    const on = harness(['', '', '', '', '', '', '', '', '', '4'], { sendLimits: ['lots', '0.2', ''] });
    expect(await runSetup([], on.deps)).toBe(0);
    expect(on.output()).toContain('"OSWIKI_DAILY_MAX_SEND_ETH": "0.2"');
    expect(on.output()).not.toContain('OSWIKI_DAILY_MAX_SEND_APE');
    expect(on.output()).toContain('Enter an amount like 0.05, or press Enter to skip.');
  });

  it('shows a new key only on explicit opt-in, once', async () => {
    const h = harness(['1', 'y', '', 'skip', 'skip', '0', '10', 'n', '', 'y', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out.split(h.keys[0]!).length - 1).toBe(1);
    expect(out).not.toContain('OSWIKI_MAX_BUY_ETH');
    expect(out).not.toContain('OSWIKI_MAX_BUY_APE');
    expect(out).toContain('"OSWIKI_DRY_RUN": "0"');
    expect(out).toContain('"OSWIKI_MIN_LIST_FLOOR_PCT": "0"');
    expect(out).toContain('"OSWIKI_CONFIRM_MODE": "off"');
  });

  it('re-asks invalid limits', async () => {
    const h = harness(['', '', '-1', '1e3', '0', '0.25', '', '150', '', '', '', '', '', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    expect(h.output()).toContain('"OSWIKI_MAX_BUY_ETH": "0.25"');
    expect(h.output()).toContain('Please enter a whole number from 0 to 100.');
  });
});

describe('setup: import', () => {
  it('validates the key at a hidden prompt and never echoes it', async () => {
    const bad = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const shortHex = 'ab'.repeat(31);
    const h = harness(['2', '', '', '', '', '', '', '', '', '4'], { secrets: [bad, shortHex, TEST_KEY.slice(2).toUpperCase()] });
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expectNoKey(out, TEST_KEY);
    expect(out).not.toContain(bad);
    expect(out).not.toContain(shortHex);
    expect(out).toContain('This key belongs to');
    expect(out).toContain(privateKeyToAccount(TEST_KEY).address);
    expect(out).toContain(`Key saved to ${keyFilePath(homedir())} (only you can read it).`);
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
    expect(h.questions.find(q => q.startsWith('Replace the key file?'))).toMatch(/\(y\/N\) - /);
    expectNoKey(h.output(), TEST_KEY);
  });

  it('keeps the existing wallet by default', async () => {
    const keyFile = seedKey();
    const h = harness(['', '', '', '', '', '', '', '', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    expect(readFileSync(keyFile, 'utf8')).toBe(`${TEST_KEY}\n`);
    expect(h.output()).toContain(privateKeyToAccount(TEST_KEY).address);
    expect(h.keys).toEqual([]);
  });

  it('backs the old key up with the same permissions when replacing', async () => {
    const keyFile = seedKey();
    const h = harness(['n', 'y', '1', '', '', '', '', '', '', '', '', '4']);
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
    const h = harness(['', '', '', '', '', '', '', '', '', '2', '']);
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
        OSWIKI_DRY_RUN: '0',
        OSWIKI_MAX_BUY_ETH: '0.05',
        OSWIKI_MAX_BUY_APE: '50',
        OSWIKI_MIN_LIST_FLOOR_PCT: '50',
        OSWIKI_MAX_TRADES_PER_DAY: '50',
        OSWIKI_CONFIRM_MODE: 'human',
      },
    });
  });

  it('creates the Claude Desktop config when missing and refuses to touch invalid JSON', async () => {
    const path = claudeDesktopConfigPath(process.platform, homedir(), process.env);
    const h = harness(['', '', '', '', '', '', '', '', '', '3', '']);
    expect(await runSetup([], h.deps)).toBe(0);
    expect(Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: object }).mcpServers)).toEqual(['oswiki-sign']);

    writeFileSync(path, '{ "mcpServers": { secret-token-123 ');
    const again = harness(['', '', '', '', '', '', '', '', '3']);
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

    const h = harness(['', '', '0.5', '500', '', '', '', '', '', '1', ''], { path: bin });
    expect(await runSetup([], h.deps)).toBe(0);

    const keyFile = keyFilePath(homedir());
    const launcher = process.platform === 'win32' ? ['cmd', '/c', 'npx'] : ['npx'];
    const expectedAdd = [
      'mcp', 'add', '--scope', 'user', 'oswiki-sign',
      '-e', `OSWIKI_WALLET_KEY_FILE=${keyFile}`,
      '-e', 'OSWIKI_DRY_RUN=0',
      '-e', 'OSWIKI_MAX_BUY_ETH=0.5',
      '-e', 'OSWIKI_MAX_BUY_APE=500',
      '-e', 'OSWIKI_MIN_LIST_FLOOR_PCT=50',
      '-e', 'OSWIKI_MAX_TRADES_PER_DAY=50',
      '-e', 'OSWIKI_CONFIRM_MODE=human',
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
    expect(h.output()).toContain(`Hardening: added ${DENY_RULES.length - 1} deny rules to ${settingsPath} (backup ${settingsPath}.bak-2026-10-11T12-00-00-000Z)`);
    expect(h.questions.some(question => /deny rules/i.test(question))).toBe(false);
  });

  it('adds the deny rules by default even when claude is not installed', async () => {
    const h = harness(['', '', '', '', '', '', '', '', '', '1']);
    expect(await runSetup([], h.deps)).toBe(0);
    const settings = JSON.parse(readFileSync(homeFile('.claude', 'settings.json'), 'utf8')) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual(DENY_RULES);
    expect(h.output()).toContain(`Hardening: added ${DENY_RULES.length} deny rules to ${homeFile('.claude', 'settings.json')} (they stop`);
    const again = harness(['', '', '', '', '', '', '', '', '1']);
    expect(await runSetup([], again.deps)).toBe(0);
    expect(again.output()).toContain('Hardening: deny rules already in');
  });

  it('prints the exact command when claude is not installed and skips hardening with --no-hardening', async () => {
    const h = harness(['', '', '', '', '', '', '', '', '', '1']);
    expect(await runSetup(['--no-hardening'], h.deps)).toBe(0);
    expect(h.output()).toContain('Hardening skipped (--no-hardening)');
    expect(h.exec.mock.calls.filter(([file]) => !file.endsWith('icacls.exe'))).toEqual([]);
    expect(h.output()).toContain('claude not found. Run this yourself:');
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

describe('setup: colors', () => {
  it('uses colors only on a TTY without NO_COLOR', () => {
    expect(useColor({}, true)).toBe(true);
    expect(useColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(useColor({}, false)).toBe(false);
    expect(useColor({ TERM: 'dumb' }, true)).toBe(false);
    expect(box(['a', 'bc'], false)).toBe('+----+\n| a  |\n| bc |\n+----+');
    expect(box(['a'], true)).toContain('┌');
  });

  it('highlights the wallet block in color and still never prints the key without a yes', async () => {
    const h = harness(['', '', '', '', '', '', '', '', '', '4'], { color: true });
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out).toContain('\u001b[1;31mNever paste this key into a chat.');
    expect(out).toContain('│');
    expectNoKey(out, h.keys[0]!);
  });
});

describe('setup: collections', () => {
  const OTHERDEED = '0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258';
  const EXPANDED = '0x790b2cf29ed4f310bf7641f013c65d4560d28371';
  const BLOCKED = '0x1111111111111111111111111111111111111111';
  const api: FetchLike = async (input) => {
    const url = new URL(input);
    const id = url.pathname.split('/').pop();
    const chainId = url.searchParams.get('chainId');
    const rows: Record<string, { address: string; name: string }> = chainId === '1'
      ? { otherdeed: { address: OTHERDEED, name: 'Otherdeed' }, [EXPANDED]: { address: EXPANDED, name: 'Otherdeed Expanded' }, [OTHERDEED]: { address: OTHERDEED, name: 'Otherdeed' }, [BLOCKED]: { address: BLOCKED, name: 'Copycat' } }
      : { [BLOCKED]: { address: BLOCKED, name: 'Copycat Ape' } };
    const row = id ? rows[id] : undefined;
    return row ? new Response(JSON.stringify({ success: true, data: row })) : new Response(JSON.stringify({ success: false, error: 'Collection not found' }), { status: 404 });
  };

  it('resolves slugs on both chains, adds the second Otherdeed contract and re-asks unknown entries', async () => {
    const h = harness(['', '', '', '', '', '', '', '2', 'otherdeed, nope', 'otherdeed', '', '', '4'], { fetch: api });
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out).toContain('Not found: nope');
    expect(out).toContain(`  Otherdeed (Ethereum) ${OTHERDEED}`);
    expect(out).toContain(`  Otherdeed Expanded (Ethereum) ${EXPANDED}`);
    expect(out).toContain(`"OSWIKI_ALLOWED_COLLECTIONS": "${OTHERDEED},${EXPANDED}"`);
    expect(out).toContain('only 2 collections');
  });

  it('writes a blocklist and shows a collection found on both chains', async () => {
    const h = harness(['', '', '', '', '', '', '', '3', BLOCKED, '', '', '4'], { fetch: api });
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out).toContain(`  Copycat (Ethereum) ${BLOCKED}`);
    expect(out).toContain(`  Copycat Ape (ApeChain) ${BLOCKED}`);
    expect(out).toContain(`"OSWIKI_BLOCKED_COLLECTIONS": "${BLOCKED}"`);
    expect(out).not.toContain('OSWIKI_ALLOWED_COLLECTIONS');
  });

  it('offline: takes raw 0x addresses only', async () => {
    const h = harness(['', '', '', '', '', '', '', '2', 'otherdeed', BLOCKED.toUpperCase().replace('0X', '0x'), '', '', '4']);
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out).toContain('OSWiki API unreachable: enter 0x addresses instead.');
    expect(out).toContain('OSWiki API unreachable: using the addresses as typed.');
    expect(out).toContain(`"OSWIKI_ALLOWED_COLLECTIONS": "${BLOCKED}"`);
  });
});

describe('setup: other clients and old configs', () => {
  it('prints hardening advice for Cursor and Claude Desktop instead of writing deny rules', async () => {
    const cursor = harness(['', '', '', '', '', '', '', '', '', '2', '']);
    expect(await runSetup([], cursor.deps)).toBe(0);
    expect(cursor.output()).toMatch(/Cursor: keep the agent away from .*\.oswiki-sign and ~\/\.cursor\/mcp\.json/);
    expect(cursor.output()).toContain('no auto-run');
    const desktop = harness(['', '', '', '', '', '', '', '', '3', '']);
    expect(await runSetup([], desktop.deps)).toBe(0);
    expect(desktop.output()).toContain('Claude Desktop: do not give it a filesystem or shell extension');
    expect(existsSync(homeFile('.claude', 'settings.json'))).toBe(false);
  });

  it('rejects unknown setup arguments', async () => {
    const h = harness([]);
    expect(await runSetup(['--no-hardening', '--yolo'], h.deps)).toBe(1);
    expect(h.output()).toContain('Unknown argument for setup.');
  });

  it('names configs that still hold the key inline, tells how to move it and never prints it', async () => {
    const cursorPath = homeFile('.cursor', 'mcp.json');
    mkdirSync(join(homedir(), '.cursor'), { recursive: true });
    writeFileSync(cursorPath, JSON.stringify({ mcpServers: { 'oswiki-sign': { command: 'npx', env: { OSWIKI_WALLET_KEY: TEST_KEY } } } }));
    writeFileSync(homeFile('.claude.json'), JSON.stringify({ mcpServers: { 'oswiki-sign': { command: 'npx', env: { OSWIKI_WALLET_KEY_FILE: '/k' } } } }));
    const h = harness(['', '', '', '', '', '', '', '', '', '2', '']);
    expect(await runSetup([], h.deps)).toBe(0);
    const out = h.output();
    expect(out).toContain(`holds the private key inline (OSWIKI_WALLET_KEY) in: ${cursorPath}.`);
    expect(out).not.toContain(homeFile('.claude.json'));
    expect(out).toContain('choose "Import key"');
    expect(out).toContain('*.bak-*');
    expectNoKey(out, TEST_KEY);
    const written = JSON.parse(readFileSync(cursorPath, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(written.mcpServers['oswiki-sign']!.env.OSWIKI_WALLET_KEY).toBeUndefined();
    expect(written.mcpServers['oswiki-sign']!.env.OSWIKI_WALLET_KEY_FILE).toBe(keyFilePath(homedir()));
  });
});

describe('setup: chat changes', () => {
  it('shows the update_limits overrides and resets them on request', async () => {
    const keyFile = keyFilePath(homedir());
    mkdirSync(join(homedir(), '.oswiki-sign'), { recursive: true });
    writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o600 });
    const stateDir = join(homedir(), '.oswiki-sign');
    writeOverrides(stateDir, settingsMacKey(loadWallet({ OSWIKI_WALLET_KEY_FILE: keyFile }).stateKey), { OSWIKI_MAX_BUY_ETH: '2' });
    const keep = harness(['', '', '', '', '', '', '', '', '', '4']);
    expect(await runSetup([], keep.deps)).toBe(0);
    expect(keep.output()).toContain('Changed from the chat (these win over setup): OSWIKI_MAX_BUY_ETH=2');
    expect(keep.output()).toContain('Chat changes kept, they win: OSWIKI_MAX_BUY_ETH');
    expect(existsSync(settingsFile(stateDir))).toBe(true);
    const reset = harness(['', 'n', '', '', '', '', '', '', '', '4']);
    expect(await runSetup([], reset.deps)).toBe(0);
    expect(reset.output()).toContain('Chat changes cleared.');
    expect(existsSync(settingsFile(stateDir))).toBe(false);
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
