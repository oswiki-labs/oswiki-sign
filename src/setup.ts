import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { ApiClient, ApiError, type FetchLike } from './api.js';
import { SetupError } from './config.js';
import { APECHAIN_ID, MAINNET_ID, OTHERDEED_CONTRACTS, type SupportedChainId } from './constants.js';
import { loadWallet } from './secret.js';
import { clearOverrides, readOverrides, settingsFile, settingsMacKey, type Overrides } from './settings.js';

export const SERVER_NAME = 'oswiki-sign';
export const PACKAGE_NAME = '@oswikixyz/sign';

export const DENY_RULES = [
  'Read(~/.oswiki-sign/**)',
  'Edit(~/.oswiki-sign/**)',
  'Read(~/.claude.json)',
  'Edit(~/.claude.json)',
  'Edit(~/.claude/settings.json)',
  'Edit(~/.claude/settings.local.json)',
  'Edit(//**/.claude/settings.json)',
  'Edit(//**/.claude/settings.local.json)',
  'Edit(//**/.mcp.json)',
];

const KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
const AMOUNT_RE = /^(\d{1,12})(\.\d{1,18})?$/;
const INT_RE = /^\d{1,6}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const SETUP_HELP = `oswiki-sign setup - interactive setup of the local OSWiki trading signer

Usage:
  npx -y ${PACKAGE_NAME}@<version> setup
  oswiki-sign setup

Five short steps:
  1/5 Wallet        create a new trading wallet or import a key; stored in ~/.oswiki-sign/key, only you can read it
  2/5 Limits        max per buy, floor guard, trades per day, dry run
  3/5 Collections   any, only these, or any except these
  4/5 Confirmation  approve each trade in oswiki-sign's dialog (recommended), or let the AI trade on its own
  5/5 Client        add to Claude Code, Cursor or Claude Desktop, or print the config

The key is never printed unless you choose to back it up, and never written to a client config.
Changed files are backed up first. Run setup again any time; it keeps your wallet unless you replace it.`;

export class SetupCancelled extends Error {
  constructor(message = 'Setup cancelled.') {
    super(message);
    this.name = 'SetupCancelled';
  }
}

export interface Prompter {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  print(text: string): void;
}

export type Exec = (file: string, args: string[], options?: { windowsVerbatimArguments?: boolean }) => string;

export interface SetupDeps {
  io: Prompter;
  isTTY: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  version: string;
  exec: Exec;
  now: () => Date;
  generateKey: () => Hex;
  color: boolean;
  fetch?: FetchLike;
}

export type Client = 'claude-code' | 'cursor' | 'claude-desktop' | 'print';

export type CollectionMode = 'any' | 'allow' | 'block';

export interface Limits {
  maxBuyEth: string | null;
  maxBuyApe: string | null;
  minListFloorPct: string;
  maxTradesPerDay: string;
  dryRun: boolean;
  confirmOff: boolean;
  collections?: { mode: CollectionMode; addresses: string[] };
}

export const NEVER_PASTE = 'Never paste this key into a chat. oswiki-sign and OSWiki never ask for it.';

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** NO_COLOR (any non-empty value), a dumb terminal or a non-TTY stdout turns colors and box-drawing off. */
export function useColor(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  return stdoutIsTTY && !env.NO_COLOR && env.TERM !== 'dumb';
}

export function paint(color: boolean) {
  const wrap = (code: string) => (text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { bold: wrap('1'), red: wrap('1;31'), cyan: wrap('1;36'), yellow: wrap('1;33'), dim: wrap('2') };
}

export function box(lines: string[], color: boolean): string {
  const visible = (text: string) => text.replace(ANSI_RE, '').length;
  const width = Math.max(...lines.map(visible));
  const [tl, tr, bl, br, h, v] = color ? ['┌', '┐', '└', '┘', '─', '│'] : ['+', '+', '+', '+', '-', '|'];
  const edge = (text: string) => (color ? `\u001b[36m${text}\u001b[0m` : text);
  return [
    edge(`${tl}${h.repeat(width + 2)}${tr}`),
    ...lines.map(line => `${edge(v)} ${line}${' '.repeat(width - visible(line))} ${edge(v)}`),
    edge(`${bl}${h.repeat(width + 2)}${br}`),
  ].join('\n');
}

function shortAddr(address: string, color: boolean): string {
  return `${address.slice(0, 6)}${color ? '…' : '...'}${address.slice(-4)}`;
}

interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

type Json = Record<string, unknown>;

export function keyFilePath(home: string): string {
  return join(home, '.oswiki-sign', 'key');
}

export function claudeDesktopConfigPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

export function cursorConfigPath(home: string): string {
  return join(home, '.cursor', 'mcp.json');
}

export function serverEnv(keyFile: string, limits: Limits): Record<string, string> {
  const env: Record<string, string> = {
    OSWIKI_WALLET_KEY_FILE: keyFile,
    OSWIKI_DRY_RUN: limits.dryRun ? '1' : '0',
  };
  if (limits.maxBuyEth !== null) env.OSWIKI_MAX_BUY_ETH = limits.maxBuyEth;
  if (limits.maxBuyApe !== null) env.OSWIKI_MAX_BUY_APE = limits.maxBuyApe;
  env.OSWIKI_MIN_LIST_FLOOR_PCT = limits.minListFloorPct;
  env.OSWIKI_MAX_TRADES_PER_DAY = limits.maxTradesPerDay;
  env.OSWIKI_CONFIRM_MODE = limits.confirmOff ? 'off' : 'human';
  const collections = limits.collections;
  if (collections && collections.mode !== 'any' && collections.addresses.length > 0) {
    env[collections.mode === 'allow' ? 'OSWIKI_ALLOWED_COLLECTIONS' : 'OSWIKI_BLOCKED_COLLECTIONS'] = collections.addresses.join(',');
  }
  return env;
}

export function serverEntry(version: string, env: Record<string, string>): ServerEntry {
  return { command: 'npx', args: ['-y', `${PACKAGE_NAME}@${version}`], env };
}

export function claudeAddArgs(version: string, env: Record<string, string>, platform: NodeJS.Platform): string[] {
  const launcher = platform === 'win32' ? ['cmd', '/c', 'npx'] : ['npx'];
  return [
    'mcp', 'add', '--scope', 'user', SERVER_NAME,
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--', ...launcher, '-y', `${PACKAGE_NAME}@${version}`,
  ];
}

export function displayCommand(args: string[], platform: NodeJS.Platform): string {
  return args.map((arg) => {
    if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
    return platform === 'win32' ? `"${arg}"` : `'${arg.replaceAll("'", "'\\''")}'`;
  }).join(' ');
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(platform === 'win32' ? ';' : ':').filter(dir => dir.trim() !== '');
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const candidate of names) {
    for (const dir of dirs) {
      const full = join(dir.trim().replace(/^"(.*)"$/, '$1'), candidate);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function cmdQuote(arg: string): string | null {
  if (/["%!\r\n]/.test(arg)) return null;
  return `"${arg}"`;
}

/** .cmd shims need cmd.exe; every argument is quoted and anything cmd would still expand inside quotes is refused. */
export function claudeInvocation(claude: string, args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; verbatim: boolean } | null {
  if (!claude.toLowerCase().endsWith('.cmd')) return { file: claude, args, verbatim: false };
  const quoted = [claude, ...args].map(cmdQuote);
  if (quoted.some(arg => arg === null)) return null;
  const comspec = env.ComSpec || join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return { file: comspec, args: ['/d', '/s', '/c', `"${quoted.join(' ')}"`], verbatim: true };
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function readJsonObject(path: string, label: string): Json | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    throw new SetupError(`Could not read ${label} (${path}).`);
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupError(`${label} (${path}) is not valid JSON. Fix it or move it away, then run setup again. Nothing was changed.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SetupError(`${label} (${path}) does not hold a JSON object. Nothing was changed.`);
  }
  return parsed as Json;
}

function backupFile(path: string, now: Date): string {
  const backup = `${path}.bak-${timestamp(now)}`;
  copyFileSync(path, backup);
  return backup;
}

function writeJson(path: string, value: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function restrictWindowsFile(deps: SetupDeps, path: string): string | null {
  const user = deps.env.USERNAME || userInfo().username;
  const icacls = join(deps.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  try {
    deps.exec(icacls, [path, '/inheritance:r', '/grant:r', `${user}:R`]);
    return null;
  } catch {
    return `Warning: could not restrict the key file to your Windows user (icacls failed). Run: icacls "${path}" /inheritance:r /grant:r "${user}:R"`;
  }
}

/** Opens with O_EXCL and an explicit mode, then fixes the mode on the descriptor, so neither umask nor a planted file matters. */
export function writeKeyFile(deps: SetupDeps, path: string, key: Hex): string | null {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (deps.platform !== 'win32') chmodSync(dir, 0o700);
  const fd = openSync(path, 'wx', 0o600);
  let warning: string | null = null;
  try {
    if (deps.platform === 'win32') warning = restrictWindowsFile(deps, path);
    else fchmodSync(fd, 0o600);
    writeSync(fd, `${key}\n`);
  } finally {
    closeSync(fd);
  }
  return warning;
}

function inspectKeyFile(path: string, platform: NodeJS.Platform): { exists: false } | { exists: true; address: string | null; stateKey: Buffer | null } {
  if (!existsSync(path)) return { exists: false };
  try {
    const wallet = loadWallet({ OSWIKI_WALLET_KEY_FILE: path }, platform);
    return { exists: true, address: wallet.account.address, stateKey: wallet.stateKey };
  } catch {
    return { exists: true, address: null, stateKey: null };
  }
}

async function askYesNo(io: Prompter, question: string, defaultYes: boolean, hint = ''): Promise<boolean> {
  for (;;) {
    const answer = (await io.ask(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'}${hint ? ` - ${hint}` : ''} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.print('Please answer y or n.');
  }
}

async function askChoice<T>(io: Prompter, options: { label: string; value: T }[], defaultIndex: number): Promise<T> {
  const line = options.map((option, index) => `${index + 1}) ${option.label}`).join('  ');
  for (;;) {
    const answer = (await io.ask(`${line} [${defaultIndex + 1}]: `)).trim();
    const index = answer === '' ? defaultIndex : Number(answer) - 1;
    const option = /^\d*$/.test(answer) ? options[index] : undefined;
    if (option) return option.value;
    io.print(`Please enter 1-${options.length}.`);
  }
}

async function askAmount(io: Prompter, question: string, fallback: string): Promise<string | null> {
  for (;;) {
    const answer = (await io.ask(`${question} [${fallback}]: `)).trim().toLowerCase();
    if (answer === 'skip') return null;
    const value = answer === '' ? fallback : answer;
    if (AMOUNT_RE.test(value) && /[1-9]/.test(value)) return value;
    io.print('Enter an amount like 0.05, or "skip".');
  }
}

async function askInt(io: Prompter, question: string, fallback: string, max: number): Promise<string> {
  for (;;) {
    const answer = (await io.ask(`${question} [${fallback}]: `)).trim();
    const value = answer === '' ? fallback : answer;
    if (INT_RE.test(value) && Number(value) <= max) return String(Number(value));
    io.print(`Please enter a whole number from 0 to ${max}.`);
  }
}

async function askPrivateKey(deps: SetupDeps): Promise<Hex> {
  const { io } = deps;
  const p = paint(deps.color);
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await io.askSecret(p.yellow('Paste the private key (hidden): '))).trim();
    if (KEY_RE.test(raw)) {
      const key = `0x${(raw.startsWith('0x') ? raw.slice(2) : raw).toLowerCase()}` as Hex;
      try {
        privateKeyToAccount(key);
        return key;
      } catch {
        io.print('Not a valid secp256k1 private key.');
        continue;
      }
    }
    io.print('Not a private key: 0x + 64 hex characters (a seed phrase does not work).');
  }
  throw new SetupCancelled('No valid private key entered. Nothing was changed.');
}

interface WalletResult {
  address: string;
  firstSetup: boolean;
  stateKey: Buffer | null;
}

async function walletStep(deps: SetupDeps, keyFile: string): Promise<WalletResult> {
  const { io, color } = deps;
  const p = paint(color);
  const never = p.red(NEVER_PASTE);
  io.print('');
  io.print(p.bold('1/5 Wallet'));
  const existing = inspectKeyFile(keyFile, deps.platform);
  if (existing.exists) {
    if (existing.address) {
      io.print(box([p.bold('Your trading wallet'), p.cyan(existing.address), `Key file: ${keyFile}`, never], color));
      if (await askYesNo(io, 'Keep it?', true)) return { address: existing.address, firstSetup: false, stateKey: existing.stateKey };
    } else {
      io.print(`${keyFile} does not hold a valid key.`);
    }
    if (!(await askYesNo(io, 'Replace the key file?', false, 'the old one is moved to key.bak-<time>'))) throw new SetupCancelled('Setup cancelled. The key file was not changed.');
  }

  const mode = await askChoice(io, [
    { label: 'New wallet (recommended)', value: 'create' as const },
    { label: 'Import key', value: 'import' as const },
  ], 0);

  let key: Hex;
  if (mode === 'create') {
    key = deps.generateKey();
  } else {
    key = await askPrivateKey(deps);
    const derived = privateKeyToAccount(key).address;
    io.print(box([p.bold('This key belongs to'), p.cyan(derived), never], color));
    if (!(await askYesNo(io, 'Use this wallet?', true))) throw new SetupCancelled('Setup cancelled. Nothing was changed.');
  }
  const address = privateKeyToAccount(key).address;

  if (existing.exists) {
    renameSync(keyFile, `${keyFile}.bak-${timestamp(deps.now())}`);
    clearOverrides(dirname(keyFile));
  }
  const warning = writeKeyFile(deps, keyFile, key);
  if (warning) io.print(warning);

  if (mode === 'create') {
    io.print(box([
      p.bold('Your new trading wallet'),
      p.cyan(address),
      `Key saved to ${keyFile} (only you can read it)`,
      'Fund it: the NFTs to trade + a little ETH / APE for gas',
      never,
    ], color));
    if (await askYesNo(io, 'Back up the private key now?', false, 'if you lose the key file, the wallet is gone')) {
      io.print(box([p.bold('Private key - store it in a password manager'), p.yellow(key)], color));
      await io.ask('Press Enter after you saved it ');
      io.print('\u001b[2J\u001b[3J\u001b[H');
      io.print(`Wallet ${address} - key backed up, screen cleared.`);
    }
  } else {
    io.print(`Key saved to ${keyFile} (only you can read it).`);
  }
  return { address, firstSetup: !existing.exists, stateKey: null };
}

async function chatOverridesStep(deps: SetupDeps, wallet: WalletResult): Promise<Overrides> {
  if (!wallet.stateKey) return {};
  const stateDir = join(deps.home, '.oswiki-sign');
  if (!existsSync(settingsFile(stateDir))) return {};
  const { overrides } = readOverrides(stateDir, settingsMacKey(wallet.stateKey));
  const entries = Object.entries(overrides);
  if (entries.length === 0) return {};
  deps.io.print(`Changed from the chat (these win over setup): ${entries.map(([key, value]) => `${key}=${value || '(unset)'}`).join(', ')}`);
  if (await askYesNo(deps.io, 'Keep the chat changes?', true)) return overrides;
  clearOverrides(stateDir);
  deps.io.print('Chat changes cleared.');
  return {};
}

async function limitsStep(deps: SetupDeps): Promise<Pick<Limits, 'maxBuyEth' | 'maxBuyApe' | 'minListFloorPct' | 'maxTradesPerDay' | 'dryRun'>> {
  const { io } = deps;
  io.print('');
  io.print(paint(deps.color).bold('2/5 Limits'));
  const maxBuyEth = await askAmount(io, 'Max per buy, ETH (skip = no buys)', '0.05');
  const maxBuyApe = await askAmount(io, 'Max per buy, APE (skip = no buys)', '50');
  const minListFloorPct = await askInt(io, 'Floor guard, % of floor (0 = off)', '50', 100);
  const maxTradesPerDay = await askInt(io, 'Trades per day', '50', 100000);
  const dryRun = await askYesNo(io, 'Dry run (nothing is sent)?', false);
  return { maxBuyEth, maxBuyApe, minListFloorPct, maxTradesPerDay, dryRun };
}

interface FoundCollection {
  name: string;
  chainId: SupportedChainId;
  address: string;
}

const CHAIN_LABEL: Record<SupportedChainId, string> = { [MAINNET_ID]: 'Ethereum', [APECHAIN_ID]: 'ApeChain' };
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** Each entry is looked up on both chains; a slug can exist on both. Otherdeed always brings its second contract. */
export async function resolveCollections(api: ApiClient, entries: string[]): Promise<{ found: FoundCollection[]; unknown: string[]; offline: boolean }> {
  let offline = false;
  const lookup = async (chainId: SupportedChainId, value: string): Promise<FoundCollection | null> => {
    try {
      const info = await api.collection(chainId, value);
      return ADDRESS_RE.test(info.address) ? { name: info.name || info.address, chainId, address: info.address.toLowerCase() } : null;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status === null || err.status >= 500) offline = true;
      return null;
    }
  };
  const found: FoundCollection[] = [];
  const unknown: string[] = [];
  for (const entry of entries) {
    if (!ADDRESS_RE.test(entry) && !SLUG_RE.test(entry)) {
      unknown.push(entry);
      continue;
    }
    const hits = (await Promise.all(([MAINNET_ID, APECHAIN_ID] as const).map(chainId => lookup(chainId, entry)))).filter((hit): hit is FoundCollection => hit !== null);
    if (hits.length === 0) unknown.push(entry);
    found.push(...hits);
  }
  for (const hit of [...found]) {
    if (hit.chainId !== MAINNET_ID || !OTHERDEED_CONTRACTS.includes(hit.address)) continue;
    for (const sibling of OTHERDEED_CONTRACTS) {
      if (found.some(entry => entry.chainId === MAINNET_ID && entry.address === sibling)) continue;
      found.push((await lookup(MAINNET_ID, sibling)) ?? { name: 'Otherdeed', chainId: MAINNET_ID, address: sibling });
    }
  }
  const seen = new Set<string>();
  return { found: found.filter(entry => !seen.has(`${entry.chainId}:${entry.address}`) && seen.add(`${entry.chainId}:${entry.address}`)), unknown, offline };
}

async function collectionsStep(deps: SetupDeps): Promise<NonNullable<Limits['collections']>> {
  const { io } = deps;
  io.print('');
  io.print(paint(deps.color).bold('3/5 Collections'));
  const mode = await askChoice<CollectionMode>(io, [
    { label: 'Any', value: 'any' },
    { label: 'Only these', value: 'allow' },
    { label: 'Any except these', value: 'block' },
  ], 0);
  if (mode === 'any') return { mode, addresses: [] };
  const api = new ApiClient({ apiKey: null, fetch: deps.fetch, timeoutMs: 10_000 });
  for (;;) {
    const entries = (await io.ask('Slugs or 0x addresses, comma-separated: ')).split(',').map(entry => entry.trim()).filter(Boolean);
    if (entries.length === 0) {
      io.print('Enter at least one collection.');
      continue;
    }
    const { found, unknown, offline } = await resolveCollections(api, entries);
    let addresses: string[];
    if (offline) {
      if (!entries.every(entry => ADDRESS_RE.test(entry))) {
        io.print('OSWiki API unreachable: enter 0x addresses instead.');
        continue;
      }
      io.print('OSWiki API unreachable: using the addresses as typed.');
      addresses = entries.map(entry => entry.toLowerCase());
      for (const address of addresses) io.print(`  ${address}`);
    } else {
      if (unknown.length > 0) {
        io.print(`Not found: ${unknown.join(', ')}`);
        continue;
      }
      for (const entry of found) io.print(`  ${entry.name} (${CHAIN_LABEL[entry.chainId]}) ${entry.address}`);
      addresses = [...new Set(found.map(entry => entry.address))];
    }
    if (await askYesNo(io, 'Use these?', true)) return { mode, addresses };
  }
}

async function confirmationStep(deps: SetupDeps): Promise<boolean> {
  const { io } = deps;
  io.print('');
  io.print(paint(deps.color).bold('4/5 Confirmation'));
  io.print('  No = you approve each trade in a dialog (recommended)');
  return askYesNo(io, 'Let the AI trade without asking you?', false);
}

function printConfig(io: Prompter, deps: SetupDeps, entry: ServerEntry): void {
  io.print('Claude Desktop / Cursor, inside "mcpServers":');
  io.print(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));
  io.print('Claude Code:');
  io.print(displayCommand(['claude', ...claudeAddArgs(deps.version, entry.env, deps.platform)], deps.platform));
}

async function addToClaudeCode(deps: SetupDeps, entry: ServerEntry): Promise<boolean> {
  const { io } = deps;
  const args = claudeAddArgs(deps.version, entry.env, deps.platform);
  const printed = displayCommand(['claude', ...args], deps.platform);
  const claude = findExecutable('claude', deps.env, deps.platform);
  const add = claude ? claudeInvocation(claude, args, deps.env) : null;
  if (!claude || !add) {
    io.print(claude ? 'The claude command cannot run safely with this key path. Run this yourself:' : 'claude not found. Run this yourself:');
    io.print(printed);
    return false;
  }

  let exists = false;
  try {
    const servers = readJsonObject(join(deps.home, '.claude.json'), '~/.claude.json')?.mcpServers;
    exists = servers !== null && typeof servers === 'object' && SERVER_NAME in servers;
  } catch {
    exists = false;
  }

  if (!(await askYesNo(io, exists ? `Replace the existing ${SERVER_NAME} in Claude Code?` : `Add ${SERVER_NAME} to Claude Code?`, true))) {
    io.print('Not added. To add it later, run:');
    io.print(printed);
    return false;
  }

  try {
    if (exists) {
      const remove = claudeInvocation(claude, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], deps.env)!;
      deps.exec(remove.file, remove.args, { windowsVerbatimArguments: remove.verbatim });
    }
    deps.exec(add.file, add.args, { windowsVerbatimArguments: add.verbatim });
  } catch {
    io.print('claude mcp add failed. Run this yourself:');
    io.print(printed);
    return false;
  }
  io.print('Added to Claude Code (user scope).');
  return true;
}

async function addToJsonConfig(deps: SetupDeps, path: string, entry: ServerEntry): Promise<boolean> {
  const { io } = deps;
  const config = readJsonObject(path, path);
  const servers = config?.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new SetupError(`"mcpServers" in ${path} is not an object. Nothing was changed.`);
  }
  if (!(await askYesNo(io, `Add ${SERVER_NAME} to ${path}?`, true))) {
    printConfig(io, deps, entry);
    return false;
  }
  if (config) io.print(`Backup: ${backupFile(path, deps.now())}`);
  writeJson(path, { ...(config ?? {}), mcpServers: { ...((servers as Json | undefined) ?? {}), [SERVER_NAME]: entry } });
  io.print(`Saved ${path}`);
  return true;
}

async function hardenClaudeCode(deps: SetupDeps): Promise<void> {
  const { io } = deps;
  const path = join(deps.home, '.claude', 'settings.json');
  io.print('  Deny rules stop the agent from reading the key or editing its own setup.');
  if (await askYesNo(io, 'Add deny rules to ~/.claude/settings.json?', true)) io.print(addDenyRules(deps, path));
  io.print('Also turn on /sandbox with ~/.oswiki-sign denied (README; on Windows use WSL2).');
}

function addDenyRules(deps: SetupDeps, path: string): string {
  let settings: Json | null;
  try {
    settings = readJsonObject(path, 'Claude Code settings');
  } catch (err) {
    return err instanceof SetupError ? err.message : 'Could not read the Claude Code settings. Nothing was changed.';
  }
  const permissions = settings?.permissions;
  if (permissions !== undefined && (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions))) {
    return `"permissions" in ${path} is not an object; add the rules by hand. Nothing was changed.`;
  }
  const deny = (permissions as Json | undefined)?.deny;
  if (deny !== undefined && (!Array.isArray(deny) || deny.some(rule => typeof rule !== 'string'))) {
    return `"permissions.deny" in ${path} is not a list of rules; add the rules by hand. Nothing was changed.`;
  }
  const current = (deny as string[] | undefined) ?? [];
  const missing = DENY_RULES.filter(rule => !current.includes(rule));
  if (missing.length === 0) return 'Deny rules already there.';
  if (settings) backupFile(path, deps.now());
  writeJson(path, { ...(settings ?? {}), permissions: { ...((permissions as Json | undefined) ?? {}), deny: [...current, ...missing] } });
  return `Added ${missing.length} deny rule${missing.length === 1 ? '' : 's'}.`;
}

async function flow(deps: SetupDeps): Promise<void> {
  const { io, color } = deps;
  const p = paint(color);
  const keyFile = keyFilePath(deps.home);
  io.print(p.bold(`oswiki-sign ${deps.version} setup`));
  io.print('Use a separate trading wallet, never your main wallet.');

  const wallet = await walletStep(deps, keyFile);
  const kept = await chatOverridesStep(deps, wallet);
  const limits: Limits = { ...(await limitsStep(deps)), collections: await collectionsStep(deps), confirmOff: await confirmationStep(deps) };
  const entry = serverEntry(deps.version, serverEnv(keyFile, limits));

  io.print('');
  io.print(p.bold('5/5 Client'));
  const client = await askChoice<Client>(io, [
    { label: 'Claude Code', value: 'claude-code' },
    { label: 'Cursor', value: 'cursor' },
    { label: 'Claude Desktop', value: 'claude-desktop' },
    { label: 'Print config', value: 'print' },
  ], 0);

  let configured = false;
  if (client === 'claude-code') configured = await addToClaudeCode(deps, entry);
  else if (client === 'cursor') configured = await addToJsonConfig(deps, cursorConfigPath(deps.home), entry);
  else if (client === 'claude-desktop') configured = await addToJsonConfig(deps, claudeDesktopConfigPath(deps.platform, deps.home, deps.env), entry);
  else printConfig(io, deps, entry);

  if (client === 'claude-code') await hardenClaudeCode(deps);
  else io.print(`Make sure the agent cannot read ${dirname(keyFile)} or edit its MCP config.`);

  const clientName = { 'claude-code': 'Claude Code', cursor: 'Cursor', 'claude-desktop': 'Claude Desktop', print: 'your AI client' }[client];
  const collections = limits.collections;
  const scope = !collections || collections.mode === 'any'
    ? 'any collection'
    : `${collections.mode === 'allow' ? 'only' : 'blocked'} ${collections.addresses.length} collection${collections.addresses.length === 1 ? '' : 's'}`;
  const confirmation = limits.confirmOff ? p.red('confirmation OFF - AI trades on its own within your limits') : 'dialog on';
  io.print('');
  io.print(`${p.bold('Done.')} Wallet ${shortAddr(wallet.address, color)} · dry run ${limits.dryRun ? 'on' : 'off'} · ${confirmation} · ${scope}`);
  if (Object.keys(kept).length > 0) io.print(`Chat changes kept, they win: ${Object.keys(kept).join(', ')}`);
  io.print(`Next: fund the wallet, ${configured ? `restart ${clientName}` : `add the config to ${clientName} and restart it`}, ask "wallet status".`);
  io.print('Keep the hosted OSWiki MCP (https://mcp.oswiki.xyz/mcp) for lookups.');
  io.print(p.red('Never paste the private key into a chat.'));
}

export async function runSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const { io } = deps;
  if (argv.includes('--help') || argv.includes('-h')) {
    io.print(SETUP_HELP);
    return 0;
  }
  if (argv.length > 0) {
    io.print(`Unknown argument for setup.\n\n${SETUP_HELP}`);
    return 1;
  }
  if (!deps.isTTY) {
    io.print('oswiki-sign setup is interactive and needs a terminal. Run it directly in a terminal window: npx -y @oswikixyz/sign@<version> setup');
    return 1;
  }
  if (!VERSION_RE.test(deps.version) || deps.version === '0.0.0') {
    io.print('oswiki-sign could not read its own version, so it cannot pin it in the client config. Reinstall it and run setup again.');
    return 1;
  }
  try {
    await flow(deps);
    return 0;
  } catch (err) {
    if (err instanceof SetupCancelled || err instanceof SetupError) {
      io.print('');
      io.print(err.message);
      return 1;
    }
    io.print('');
    io.print(`Setup failed: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'}`);
    return 1;
  }
}

function readHidden(input: NodeJS.ReadStream, output: NodeJS.WriteStream, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw;
    let value = '';
    const finish = (err?: Error) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (err) {
        value = '';
        reject(err);
      } else {
        resolve(value);
      }
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.startsWith('\u001b')) return;
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new SetupCancelled());
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        output.write('*');
      }
    };
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

export function createTerminalPrompter(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Prompter {
  return {
    print: text => output.write(`${text}\n`),
    ask: question => new Promise((resolve, reject) => {
      const rl = createInterface({ input, output, terminal: true, historySize: 0 });
      let settled = false;
      rl.on('SIGINT', () => {
        settled = true;
        rl.close();
        output.write('\n');
        reject(new SetupCancelled());
      });
      rl.on('close', () => {
        if (!settled) reject(new SetupCancelled());
      });
      rl.question(question, (answer) => {
        settled = true;
        rl.close();
        resolve(answer);
      });
    }),
    askSecret: question => readHidden(input, output, question),
  };
}

export function defaultSetupDeps(version: string): SetupDeps {
  return {
    io: createTerminalPrompter(process.stdin, process.stdout),
    isTTY: process.stdin.isTTY === true,
    platform: process.platform,
    env: process.env,
    home: homedir(),
    version,
    exec: (file, args, options) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options }),
    now: () => new Date(),
    generateKey: generatePrivateKey,
    color: useColor(process.env, process.stdout.isTTY === true),
  };
}
