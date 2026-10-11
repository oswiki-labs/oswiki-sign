import { execFileSync, spawn } from 'node:child_process';
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
import { compareVersions } from './update-check.js';

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
  npx -y ${PACKAGE_NAME} setup [--no-hardening]
  oswiki-sign setup [--no-hardening]

Five short steps:
  1/5 Wallet        create a new trading wallet or import a key; stored in ~/.oswiki-sign/key, only you can read it
  2/5 Limits        recommended limits in one step, or set max per buy, floor guard, trades per day, dry run
  3/5 Collections   any, only these, or any except these
  4/5 Confirmation  approve each trade in oswiki-sign's dialog (recommended), or let the AI trade on its own
  5/5 Client        add to Claude Code, Cursor or Claude Desktop, or print the config

For Claude Code, setup also adds deny rules to ~/.claude/settings.json (backed up first) so the agent
cannot read the key or edit its own setup. --no-hardening skips that.

The key is never printed unless you choose to back it up, and never written to a client config.
Changed files are backed up first. Run setup again any time; it keeps your wallet unless you replace it.
To move every configured app to the newest version later: npx -y ${PACKAGE_NAME}@latest update`;

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

export interface SpawnedServer {
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

export type Spawn = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean }) => SpawnedServer;

export interface SetupDeps {
  io: Prompter;
  isTTY: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  version: string;
  exec: Exec;
  spawn: Spawn;
  cwd: string;
  selfTestTimeoutMs?: number;
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
  dailyMaxSendEth?: string | null;
  dailyMaxSendApe?: string | null;
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
  if (limits.dailyMaxSendEth) env.OSWIKI_DAILY_MAX_SEND_ETH = limits.dailyMaxSendEth;
  if (limits.dailyMaxSendApe) env.OSWIKI_DAILY_MAX_SEND_APE = limits.dailyMaxSendApe;
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

async function askOptionalAmount(io: Prompter, question: string): Promise<string | null> {
  for (;;) {
    const answer = (await io.ask(`${question} [skip]: `)).trim().toLowerCase();
    if (answer === '' || answer === 'skip') return null;
    if (AMOUNT_RE.test(answer) && /[1-9]/.test(answer)) return answer;
    io.print('Enter an amount like 0.05, or press Enter to skip.');
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

type StepLimits = Pick<Limits, 'maxBuyEth' | 'maxBuyApe' | 'dailyMaxSendEth' | 'dailyMaxSendApe' | 'minListFloorPct' | 'maxTradesPerDay' | 'dryRun'>;

export const RECOMMENDED_LIMITS = {
  maxBuyEth: '0.05',
  maxBuyApe: '25',
  dailyMaxSendEth: null,
  dailyMaxSendApe: null,
  minListFloorPct: '50',
  maxTradesPerDay: '50',
  dryRun: false,
} as const satisfies StepLimits;

async function limitsStep(deps: SetupDeps): Promise<StepLimits> {
  const { io } = deps;
  io.print('');
  io.print(paint(deps.color).bold('2/5 Limits') + ' (change them any time later from the chat)');
  const r = RECOMMENDED_LIMITS;
  io.print(`Recommended: max ${r.maxBuyEth} ETH / ${r.maxBuyApe} APE per buy, floor guard ${r.minListFloorPct}%, ${r.maxTradesPerDay} trades/day, dry run off, sends off`);
  if (await askYesNo(io, 'Use recommended limits?', true)) return { ...r };
  const maxBuyEth = await askAmount(io, 'Most the AI may pay for one buy, in ETH (skip = no buying on Ethereum)', r.maxBuyEth);
  const maxBuyApe = await askAmount(io, 'Most the AI may pay for one buy, in APE (skip = no buying on ApeChain)', r.maxBuyApe);
  const minListFloorPct = await askInt(io, 'Never sell below this % of the floor price (0 = no check)', r.minListFloorPct, 100);
  const maxTradesPerDay = await askInt(io, 'Most trades per day', r.maxTradesPerDay, 100000);
  const dryRun = await askYesNo(io, 'Test mode: show everything but never send?', false);
  io.print('Sending coins (ETH, APE, WETH, WAPE) to other wallets stays off unless you set a daily amount. You approve every send yourself.');
  const dailyMaxSendEth = await askOptionalAmount(io, 'Daily send limit, ETH + WETH (skip = no sending)');
  const dailyMaxSendApe = await askOptionalAmount(io, 'Daily send limit, APE + WAPE (skip = no sending)');
  return { maxBuyEth, maxBuyApe, dailyMaxSendEth, dailyMaxSendApe, minListFloorPct, maxTradesPerDay, dryRun };
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
  io.print(paint(deps.color).bold('3/5 Collections') + ' - which collections may the AI trade?');
  const mode = await askChoice<CollectionMode>(io, [
    { label: 'All', value: 'any' },
    { label: 'Only these', value: 'allow' },
    { label: 'All except these', value: 'block' },
  ], 0);
  if (mode === 'any') return { mode, addresses: [] };
  const api = new ApiClient({ apiKey: null, fetch: deps.fetch, timeoutMs: 10_000 });
  for (;;) {
    const entries = (await io.ask('Collection names (slugs) or 0x addresses, comma-separated: ')).split(',').map(entry => entry.trim()).filter(Boolean);
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
  io.print('Should the AI trade on its own, within your limits?');
  io.print('  No  = a pop-up asks you before every trade (recommended)');
  io.print('  Yes = no pop-up for trades; sends and setting changes still ask you');
  return askYesNo(io, 'Trade on its own', false);
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

function hasServer(servers: unknown): boolean {
  return servers !== null && typeof servers === 'object' && !Array.isArray(servers) && Object.hasOwn(servers, SERVER_NAME);
}

/** Folders with a local-scope entry in ~/.claude.json; those win over the user-scope entry setup writes. */
export function localScopeFolders(home: string): string[] {
  try {
    const projects = readJsonObject(join(home, '.claude.json'), '~/.claude.json')?.projects;
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return [];
    return Object.entries(projects as Json)
      .filter(([, project]) => project !== null && typeof project === 'object' && hasServer((project as Json).mcpServers))
      .map(([folder]) => folder);
  } catch {
    return [];
  }
}

export function projectScopeFile(cwd: string): string | null {
  const path = join(cwd, '.mcp.json');
  try {
    return hasServer(readJsonObject(path, path)?.mcpServers) ? path : null;
  } catch {
    return null;
  }
}

/** Edits ~/.claude.json directly: running claude with a project folder as cwd would run any node shim planted there. */
export function removeLocalScopeEntries(home: string, folders: string[], now: Date): { backup: string | null; left: string[] } {
  const path = join(home, '.claude.json');
  const config = readJsonObject(path, '~/.claude.json');
  const projects = config?.projects;
  if (!config || projects === null || typeof projects !== 'object' || Array.isArray(projects)) return { backup: null, left: [...folders] };
  const backup = backupFile(path, now);
  for (const folder of folders) {
    if (!Object.hasOwn(projects, folder)) continue;
    const project = (projects as Json)[folder];
    const servers = project !== null && typeof project === 'object' ? (project as Json).mcpServers : null;
    if (hasServer(servers)) delete (servers as Json)[SERVER_NAME];
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
  return { backup, left: localScopeFolders(home).filter(folder => folders.includes(folder)) };
}

async function removeShadowingEntries(deps: SetupDeps): Promise<void> {
  const { io } = deps;
  const p = paint(deps.color);
  const folders = localScopeFolders(deps.home);
  const manual = () => io.print(`  In ~/.claude.json, delete "${SERVER_NAME}" under "projects" > each of these folders > "mcpServers".`);
  if (folders.length > 0) {
    io.print(p.yellow(`${SERVER_NAME} is also set for single folders (local scope). In those folders it wins over the entry setup writes, and an outdated one shows as CONNECTION_CLOSED:`));
    for (const folder of folders) io.print(`  ${folder}`);
    if (await askYesNo(io, `Remove ${folders.length === 1 ? 'it' : 'them'}?`, true)) {
      let result: { backup: string | null; left: string[] };
      try {
        result = removeLocalScopeEntries(deps.home, folders, deps.now());
      } catch {
        result = { backup: null, left: localScopeFolders(deps.home).filter(folder => folders.includes(folder)) };
      }
      const removed = folders.length - result.left.length;
      if (removed > 0) io.print(`Removed ${removed} folder entr${removed === 1 ? 'y' : 'ies'} from ~/.claude.json${result.backup ? ` (backup ${result.backup})` : ''}.`);
      if (result.left.length > 0) {
        io.print('Could not remove these:');
        for (const folder of result.left) io.print(`  ${folder}`);
        manual();
      }
    } else {
      io.print('Kept. To remove them later:');
      manual();
    }
  }
  const projectFile = projectScopeFile(deps.cwd);
  if (projectFile) {
    io.print(p.yellow(`${projectFile} also defines ${SERVER_NAME} (project scope). In this folder it wins over the entry setup writes; remove it there or make it match.`));
  }
}

const READY_RE = /oswiki-sign (\S+) ready for (0x[0-9a-fA-F]{40})/;
const HEX_RUN_RE = /[0-9a-fA-F]{64,}/g;
export const SELF_TEST_TIMEOUT_MS = 20_000;

export type SelfTestResult =
  | { ok: true; version: string; address: string }
  | { ok: false; reason: 'npx-missing' | 'unsafe' | 'spawn' | 'exited' | 'timeout'; output: string };

/** Starts the server the way the client will (same package pin and env) and waits for its ready line on stderr. */
export function selfTestServer(deps: Pick<SetupDeps, 'env' | 'platform' | 'version' | 'spawn' | 'selfTestTimeoutMs'>, serverEnvVars: Record<string, string>): Promise<SelfTestResult> {
  const npx = findExecutable('npx', deps.env, deps.platform);
  if (!npx) return Promise.resolve({ ok: false, reason: 'npx-missing', output: '' });
  const run = claudeInvocation(npx, ['-y', `${PACKAGE_NAME}@${deps.version}`], deps.env);
  if (!run) return Promise.resolve({ ok: false, reason: 'unsafe', output: '' });
  return new Promise((resolve) => {
    let stderr = '';
    let child: SpawnedServer | null = null;
    let done = false;
    const finish = (result: SelfTestResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } finally {
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', output: stderr }), deps.selfTestTimeoutMs ?? SELF_TEST_TIMEOUT_MS);
    try {
      child = deps.spawn(run.file, run.args, { env: { ...deps.env, ...serverEnvVars }, windowsVerbatimArguments: run.verbatim });
    } catch {
      finish({ ok: false, reason: 'spawn', output: '' });
      return;
    }
    child.onStderr((chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
      const ready = READY_RE.exec(stderr);
      if (ready) finish({ ok: true, version: ready[1]!, address: ready[2]! });
    });
    child.onExit(() => finish({ ok: false, reason: 'exited', output: stderr }));
  });
}

function keyScrubber(keyFile: string, platform: NodeJS.Platform): (text: string) => string {
  const generic = (text: string) => text.replace(HEX_RUN_RE, '[redacted]');
  try {
    const { scrub } = loadWallet({ OSWIKI_WALLET_KEY_FILE: keyFile }, platform);
    return text => generic(scrub(text));
  } catch {
    return generic;
  }
}

async function selfTestStep(deps: SetupDeps, entry: ServerEntry, keyFile: string, walletAddress: string | null): Promise<boolean> {
  const { io, color } = deps;
  const p = paint(color);
  io.print('');
  io.print(`Checking that ${SERVER_NAME} starts (npx can take a few seconds)...`);
  const result = await selfTestServer(deps, entry.env);
  if (result.ok) {
    io.print(`${color ? '✓' : 'OK'} ${SERVER_NAME} ${result.version} ready for ${result.address}`);
    if (walletAddress && result.address.toLowerCase() !== walletAddress.toLowerCase()) {
      io.print(p.red(`That is not the wallet set up here (${walletAddress}). Check OSWIKI_WALLET_KEY_FILE in the client config.`));
    }
    return true;
  }
  const seconds = Math.round((deps.selfTestTimeoutMs ?? SELF_TEST_TIMEOUT_MS) / 1000);
  const reason = {
    'npx-missing': 'npx not found in PATH',
    unsafe: 'npx cannot run safely from this path',
    spawn: 'npx could not be started',
    exited: 'it stopped',
    timeout: `no ready line within ${seconds}s`,
  }[result.reason];
  const scrub = keyScrubber(keyFile, deps.platform);
  const lines = scrub(result.output).replace(ANSI_RE, '').split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() !== '').slice(-8);
  io.print(p.red(`${color ? '✗' : 'FAILED'} ${SERVER_NAME} did not start: ${reason}`));
  for (const line of lines) io.print(`  ${line.slice(0, 300)}`);
  io.print(result.reason === 'timeout'
    ? 'Hint: npx may still be downloading the package on a slow connection; restart the client and it tries again. If the client then shows CONNECTION_CLOSED, run setup again.'
    : `Hint: the client shows CONNECTION_CLOSED until this works. Check that Node.js 20+ and npx work in this terminal (npx -y ${PACKAGE_NAME}@${deps.version} --version), then run setup again.`);
  return false;
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

function hardenClaudeCode(deps: SetupDeps, enabled: boolean): void {
  const { io } = deps;
  if (!enabled) {
    io.print('Hardening skipped (--no-hardening): add the Claude Code deny rules from the README by hand.');
    return;
  }
  io.print(`Protection: ${addDenyRules(deps, claudeSettingsPath(deps.home))} (Claude Code can no longer read your key or change this setup)`);
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
  if (missing.length === 0) return `deny rules already in ${path}`;
  const backup = settings ? backupFile(path, deps.now()) : null;
  writeJson(path, { ...(settings ?? {}), permissions: { ...((permissions as Json | undefined) ?? {}), deny: [...current, ...missing] } });
  return `added ${missing.length} deny rule${missing.length === 1 ? '' : 's'} to ${path}${backup ? ` (backup ${backup})` : ''}`;
}

export function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

/** Read-only and best effort: null when the settings cannot be read or parsed. */
export function missingDenyRules(home: string): string[] | null {
  try {
    const settings = readJsonObject(claudeSettingsPath(home), 'Claude Code settings');
    const deny = (settings?.permissions as Json | undefined)?.deny;
    const current = Array.isArray(deny) ? deny.filter((rule): rule is string => typeof rule === 'string') : [];
    return DENY_RULES.filter(rule => !current.includes(rule));
  } catch {
    return null;
  }
}

export function isClaudeCode(clientName: string | undefined): boolean {
  return clientName !== undefined && /^claude[- ]?code$/i.test(clientName.trim());
}

const INLINE_KEY_HELP = [
  'Move it to a key file: in step 1 choose "Import key" and paste the key at the hidden prompt (it is saved to ~/.oswiki-sign/key, readable only by you),',
  'or write it to a file yourself (README, Manual setup) and set OSWIKI_WALLET_KEY_FILE to its path.',
  'Setup then writes an entry that holds only the key file path. Afterwards delete OSWIKI_WALLET_KEY from any config left over and the *.bak-* backups of these files, which still hold the key.',
].join(' ');

/** Configs may still hold the key inline; only file names are reported, never the value. */
export function inlineKeyConfigs(deps: Pick<SetupDeps, 'home' | 'platform' | 'env'>): string[] {
  const candidates = [join(deps.home, '.claude.json'), cursorConfigPath(deps.home), claudeDesktopConfigPath(deps.platform, deps.home, deps.env)];
  return candidates.filter((path) => {
    try {
      const servers = readJsonObject(path, path)?.mcpServers as Json | undefined;
      const env = (servers?.[SERVER_NAME] as Json | undefined)?.env as Json | undefined;
      return typeof env?.OSWIKI_WALLET_KEY === 'string' && env.OSWIKI_WALLET_KEY.trim() !== '';
    } catch {
      return false;
    }
  });
}

function hardeningAdvice(client: Client, keyDir: string): string[] {
  if (client === 'cursor') {
    return [
      `Cursor: keep the agent away from ${keyDir} and ~/.cursor/mcp.json.`,
      '  Do not let it run terminal commands without asking (no auto-run), keep its dotfile and external-file protection on, and review every edit outside your project.',
    ];
  }
  if (client === 'claude-desktop') {
    return [
      `Claude Desktop: do not give it a filesystem or shell extension that can reach ${keyDir} or claude_desktop_config.json;`,
      '  limit such extensions to the project folders you work in.',
    ];
  }
  return [`Make sure the agent cannot read ${keyDir} or edit its MCP config.`];
}

async function flow(deps: SetupDeps, options: { hardening: boolean }): Promise<void> {
  const { io, color } = deps;
  const p = paint(color);
  const keyFile = keyFilePath(deps.home);
  io.print(p.bold(`oswiki-sign ${deps.version} setup`));
  io.print('Lets your AI trade NFTs with a wallet on this computer. Use a separate wallet with only what you want it to trade, never your main wallet.');
  const inline = inlineKeyConfigs(deps);
  if (inline.length > 0) {
    io.print('');
    io.print(p.red(`Your existing config holds the private key inline (OSWIKI_WALLET_KEY) in: ${inline.join(', ')}.`));
    io.print(`oswiki-sign ${deps.version} no longer starts with an inline key. ${INLINE_KEY_HELP}`);
  }

  const wallet = await walletStep(deps, keyFile);
  const kept = await chatOverridesStep(deps, wallet);
  const limits: Limits = { ...(await limitsStep(deps)), collections: await collectionsStep(deps), confirmOff: await confirmationStep(deps) };
  const entry = serverEntry(deps.version, serverEnv(keyFile, limits));

  io.print('');
  io.print(p.bold('5/5 App') + ' - where do you use the AI?');
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

  if (client === 'claude-code') await removeShadowingEntries(deps);
  if (client === 'claude-code') hardenClaudeCode(deps, options.hardening);
  else for (const line of hardeningAdvice(client, dirname(keyFile))) io.print(line);
  if (configured) await selfTestStep(deps, entry, keyFile, wallet.address);

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
  const hardening = !argv.includes('--no-hardening');
  if (argv.some(arg => arg !== '--no-hardening')) {
    io.print(`Unknown argument for setup.\n\n${SETUP_HELP}`);
    return 1;
  }
  if (!deps.isTTY) {
    io.print('oswiki-sign setup is interactive and needs a terminal. Run it directly in a terminal window: npx -y @oswikixyz/sign setup');
    return 1;
  }
  if (!VERSION_RE.test(deps.version) || deps.version === '0.0.0') {
    io.print('oswiki-sign could not read its own version, so it cannot pin it in the client config. Reinstall it and run setup again.');
    return 1;
  }
  try {
    await flow(deps, { hardening });
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

export const UPDATE_HELP = `oswiki-sign update - move every configured app to this version

Usage:
  npx -y ${PACKAGE_NAME}@latest update
  oswiki-sign update

Finds the ${SERVER_NAME} entry of Claude Code (user scope), Cursor and Claude Desktop, sets the
package version pinned in it to the version running this command and keeps every setting.
Then it checks that the server starts. Restart the apps afterwards. Changed files are backed up first.
Nothing updates by itself: the version stays pinned until you run this again.`;

const PACKAGE_ARG_RE = /^@oswikixyz\/sign(?:@(\S+))?$/;

type UpdateOutcome = 'updated' | 'current' | 'newer' | 'failed';

interface ClientUpdate {
  label: string;
  outcome: UpdateOutcome;
  env: Record<string, string>;
}

interface ExistingEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
  index: number;
  current: string | null;
}

function existingEntry(servers: unknown): ExistingEntry | 'not-npx' | 'invalid' | 'inline-key' | null {
  if (!hasServer(servers)) return null;
  const entry = (servers as Json)[SERVER_NAME];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid';
  const { command, args, env } = entry as Json;
  if (typeof command !== 'string' || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return 'invalid';
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string'))) return 'invalid';
  const vars = (env ?? {}) as Record<string, string>;
  if (typeof vars.OSWIKI_WALLET_KEY === 'string' && vars.OSWIKI_WALLET_KEY.trim() !== '') return 'inline-key';
  const index = (args as string[]).findIndex(arg => PACKAGE_ARG_RE.test(arg));
  if (index === -1) return 'not-npx';
  return { command, args: args as string[], env: vars, index, current: PACKAGE_ARG_RE.exec((args as string[])[index]!)![1] ?? null };
}

function reportProblem(io: Prompter, where: string, problem: 'not-npx' | 'invalid' | 'inline-key'): void {
  io.print({
    'not-npx': `${where}: the ${SERVER_NAME} entry does not start ${PACKAGE_NAME} through npx; left unchanged.`,
    invalid: `${where}: the ${SERVER_NAME} entry is not in the expected format; left unchanged. Run setup again.`,
    'inline-key': `${where}: the ${SERVER_NAME} entry still holds the private key inline (OSWIKI_WALLET_KEY); left unchanged. Run \`npx -y ${PACKAGE_NAME} setup\` to move it to a key file.`,
  }[problem]);
}

function versionCheck(io: Prompter, where: string, found: ExistingEntry, version: string, label: string): ClientUpdate | null {
  if (found.current === version) {
    io.print(`${where}: already ${version}`);
    return { label, outcome: 'current', env: found.env };
  }
  if (found.current !== null && compareVersions(found.current, version) === 1) {
    io.print(`${where}: has ${found.current}, newer than ${version}; left unchanged. Run \`npx -y ${PACKAGE_NAME}@latest update\`.`);
    return { label, outcome: 'newer', env: found.env };
  }
  return null;
}

function updateJsonClient(deps: SetupDeps, label: string, path: string): ClientUpdate | null {
  const { io } = deps;
  const where = `${label} (${path})`;
  let config: Json | null;
  try {
    config = readJsonObject(path, path);
  } catch (err) {
    io.print(`${label}: ${err instanceof SetupError ? err.message : `could not read ${path}.`}`);
    return { label, outcome: 'failed', env: {} };
  }
  const servers = config?.mcpServers;
  const found = existingEntry(servers);
  if (found === null) return null;
  if (typeof found === 'string') {
    reportProblem(io, where, found);
    return { label, outcome: 'failed', env: {} };
  }
  const done = versionCheck(io, where, found, deps.version, label);
  if (done) return done;
  const args = found.args.map((arg, index) => (index === found.index ? `${PACKAGE_NAME}@${deps.version}` : arg));
  const backup = backupFile(path, deps.now());
  writeJson(path, { ...config, mcpServers: { ...(servers as Json), [SERVER_NAME]: { ...((servers as Json)[SERVER_NAME] as Json), args } } });
  io.print(`${where}: ${found.current ?? 'unpinned'} -> ${deps.version} (backup ${backup})`);
  return { label, outcome: 'updated', env: found.env };
}

function claudeCodeAddArgs(command: string, args: string[], env: Record<string, string>): string[] {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), '--', command, ...args];
}

function updateClaudeCode(deps: SetupDeps): ClientUpdate | null {
  const { io } = deps;
  const label = 'Claude Code';
  const path = join(deps.home, '.claude.json');
  let config: Json | null;
  try {
    config = readJsonObject(path, '~/.claude.json');
  } catch (err) {
    io.print(`${label}: ${err instanceof SetupError ? err.message : 'could not read ~/.claude.json.'}`);
    return { label, outcome: 'failed', env: {} };
  }
  const found = existingEntry(config?.mcpServers);
  const shadows = localScopeFolders(deps.home);
  if (shadows.length > 0) {
    io.print(`${label}: ${SERVER_NAME} is also set for single folders (local scope), which win over the user entry there: ${shadows.join(', ')}. Run \`npx -y ${PACKAGE_NAME} setup\` to remove them.`);
  }
  if (found === null) return null;
  const where = `${label} (user scope)`;
  if (typeof found === 'string') {
    reportProblem(io, where, found);
    return { label, outcome: 'failed', env: {} };
  }
  const done = versionCheck(io, where, found, deps.version, label);
  if (done) return done;
  const manual = `${where}: could not run claude. In ~/.claude.json under "mcpServers" > "${SERVER_NAME}" > "args", change "${found.args[found.index]}" to "${PACKAGE_NAME}@${deps.version}", or run \`npx -y ${PACKAGE_NAME} setup\`.`;
  const claude = findExecutable('claude', deps.env, deps.platform);
  const args = found.args.map((arg, index) => (index === found.index ? `${PACKAGE_NAME}@${deps.version}` : arg));
  const remove = claude ? claudeInvocation(claude, ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], deps.env) : null;
  const add = claude ? claudeInvocation(claude, claudeCodeAddArgs(found.command, args, found.env), deps.env) : null;
  const restore = claude ? claudeInvocation(claude, claudeCodeAddArgs(found.command, found.args, found.env), deps.env) : null;
  if (!remove || !add || !restore) {
    io.print(manual);
    return { label, outcome: 'failed', env: found.env };
  }
  try {
    deps.exec(remove.file, remove.args, { windowsVerbatimArguments: remove.verbatim });
  } catch {
    io.print(manual);
    return { label, outcome: 'failed', env: found.env };
  }
  try {
    deps.exec(add.file, add.args, { windowsVerbatimArguments: add.verbatim });
  } catch {
    try {
      deps.exec(restore.file, restore.args, { windowsVerbatimArguments: restore.verbatim });
      io.print(`${where}: claude mcp add failed; the previous entry was put back.`);
    } catch {
      io.print(`${where}: claude mcp add failed and the previous entry could not be put back. Run \`npx -y ${PACKAGE_NAME} setup\`.`);
    }
    return { label, outcome: 'failed', env: found.env };
  }
  io.print(`${where}: ${found.current ?? 'unpinned'} -> ${deps.version}`);
  return { label, outcome: 'updated', env: found.env };
}

export async function runUpdate(argv: string[], deps: SetupDeps): Promise<number> {
  const { io } = deps;
  if (argv.includes('--help') || argv.includes('-h')) {
    io.print(UPDATE_HELP);
    return 0;
  }
  if (argv.length > 0) {
    io.print(`Unknown argument for update.\n\n${UPDATE_HELP}`);
    return 1;
  }
  if (!VERSION_RE.test(deps.version) || deps.version === '0.0.0') {
    io.print('oswiki-sign could not read its own version, so it cannot pin it in the client configs. Reinstall it and run update again.');
    return 1;
  }
  io.print(`oswiki-sign ${deps.version} update`);
  const results = [
    updateClaudeCode(deps),
    updateJsonClient(deps, 'Cursor', cursorConfigPath(deps.home)),
    updateJsonClient(deps, 'Claude Desktop', claudeDesktopConfigPath(deps.platform, deps.home, deps.env)),
  ].filter((result): result is ClientUpdate => result !== null);
  const projectFile = projectScopeFile(deps.cwd);
  if (projectFile) io.print(`${projectFile} also defines ${SERVER_NAME} (project scope) and wins in this folder; update its version there by hand.`);
  if (results.length === 0) {
    io.print(`No app is set up with ${SERVER_NAME} yet. Run: npx -y ${PACKAGE_NAME} setup`);
    return 1;
  }
  const tested = results.find(result => result.outcome === 'updated' || result.outcome === 'current');
  let started = true;
  if (tested) {
    const keyFile = tested.env.OSWIKI_WALLET_KEY_FILE ?? keyFilePath(deps.home);
    const key = inspectKeyFile(keyFile, deps.platform);
    started = await selfTestStep(deps, serverEntry(deps.version, tested.env), keyFile, key.exists ? key.address : null);
  }
  const updated = results.filter(result => result.outcome === 'updated').map(result => result.label);
  io.print('');
  io.print(updated.length > 0 ? `Done. Restart ${updated.join(', ')} to start ${deps.version}.` : 'Nothing to change.');
  return started && results.every(result => result.outcome !== 'failed') ? 0 : 1;
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

/** npx and cmd.exe leave the server as a grandchild, so the whole tree (Windows) or process group (POSIX) is stopped. */
function spawnServer(file: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean }): SpawnedServer {
  const windows = process.platform === 'win32';
  const child = spawn(file, args, { env: options.env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments, detached: !windows });
  return {
    onStderr: listener => child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))),
    onExit: (listener) => {
      child.on('close', listener);
      child.on('error', listener);
      child.stdin?.on('error', () => undefined);
    },
    kill: () => {
      child.stdin?.destroy();
      const pid = child.pid;
      if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (windows) execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    },
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
    spawn: spawnServer,
    cwd: process.cwd(),
    now: () => new Date(),
    generateKey: generatePrivateKey,
    color: useColor(process.env, process.stdout.isTTY === true),
  };
}
