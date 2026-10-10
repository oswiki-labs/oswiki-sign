import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { SetupError } from './config.js';
import { loadWallet } from './secret.js';

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

Asks a few questions in the terminal, then:
  1. creates a new trading wallet (recommended) or imports an existing private key, and stores the key in
     ~/.oswiki-sign/key (Windows: %USERPROFILE%\\.oswiki-sign\\key), readable only by you;
  2. sets the limits: max buy per chain, min % of floor for listings, trades per day, dry run;
  3. adds oswiki-sign to Claude Code, Cursor or Claude Desktop, or prints the config to copy;
  4. for Claude Code, adds deny rules to ~/.claude/settings.json so the agent cannot read the key file or
     change its own setup.

The key is never printed (unless you ask to see a new key once to back it up) and never written to any client
config: the config only holds the path of the key file. Existing files are backed up before they are changed.
Run setup again at any time to change the limits or turn dry run off; it keeps your wallet unless you replace it.`;

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
}

export type Client = 'claude-code' | 'cursor' | 'claude-desktop' | 'print';

export interface Limits {
  maxBuyEth: string | null;
  maxBuyApe: string | null;
  minListFloorPct: string;
  maxTradesPerDay: string;
  dryRun: boolean;
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

function inspectKeyFile(path: string, platform: NodeJS.Platform): { exists: false } | { exists: true; address: string | null } {
  if (!existsSync(path)) return { exists: false };
  try {
    return { exists: true, address: loadWallet({ OSWIKI_WALLET_KEY_FILE: path }, platform).account.address };
  } catch {
    return { exists: true, address: null };
  }
}

async function askYesNo(io: Prompter, question: string, defaultYes: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await io.ask(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.print('Please answer y or n.');
  }
}

async function askChoice<T>(io: Prompter, question: string, options: { label: string; value: T }[], defaultIndex: number): Promise<T> {
  io.print(question);
  options.forEach((option, index) => io.print(`  ${index + 1}) ${option.label}`));
  for (;;) {
    const answer = (await io.ask(`Choose 1-${options.length} [${defaultIndex + 1}]: `)).trim();
    const index = answer === '' ? defaultIndex : Number(answer) - 1;
    const option = /^\d*$/.test(answer) ? options[index] : undefined;
    if (option) return option.value;
    io.print(`Please enter a number from 1 to ${options.length}.`);
  }
}

async function askAmount(io: Prompter, question: string, fallback: string): Promise<string | null> {
  for (;;) {
    const answer = (await io.ask(`${question} [${fallback}, or "skip"]: `)).trim().toLowerCase();
    if (answer === 'skip') return null;
    const value = answer === '' ? fallback : answer;
    if (AMOUNT_RE.test(value) && /[1-9]/.test(value)) return value;
    io.print('Please enter an amount like 0.05, or "skip".');
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

async function askPrivateKey(io: Prompter): Promise<Hex> {
  io.print('The key is read at a hidden prompt: nothing you type or paste is shown.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await io.askSecret('Private key (0x followed by 64 hex characters): ')).trim();
    if (KEY_RE.test(raw)) {
      const key = `0x${(raw.startsWith('0x') ? raw.slice(2) : raw).toLowerCase()}` as Hex;
      try {
        privateKeyToAccount(key);
        return key;
      } catch {
        io.print('That is not a valid secp256k1 private key.');
        continue;
      }
    }
    io.print('That is not a private key: it must be 0x followed by 64 hex characters (a seed phrase does not work here).');
  }
  throw new SetupCancelled('No valid private key entered. Nothing was changed.');
}

async function walletStep(deps: SetupDeps, keyFile: string): Promise<{ address: string; firstSetup: boolean }> {
  const { io } = deps;
  io.print('');
  io.print('Step 1 of 4: wallet');
  const existing = inspectKeyFile(keyFile, deps.platform);
  if (existing.exists) {
    if (existing.address) {
      io.print(`A key file already exists: ${keyFile}`);
      io.print(`It belongs to the wallet ${existing.address}.`);
      if (await askYesNo(io, 'Keep using this wallet?', true)) return { address: existing.address, firstSetup: false };
    } else {
      io.print(`${keyFile} already exists but does not hold a valid private key.`);
    }
    io.print('Replacing it moves the current key file to a key.bak-<time> file next to it. Anything left in the old wallet stays there, and that backup is the only way to reach it.');
    if (!(await askYesNo(io, 'Replace the existing key file?', false))) throw new SetupCancelled('Setup cancelled. The existing key file was not changed.');
  }

  const mode = await askChoice(io, 'Create a new trading wallet (recommended) or import an existing key?', [
    { label: 'Create a new trading wallet (recommended)', value: 'create' as const },
    { label: 'Import an existing private key', value: 'import' as const },
  ], 0);

  let key: Hex;
  if (mode === 'create') {
    key = deps.generateKey();
  } else {
    io.print('Use a separate trading wallet, never your main wallet.');
    key = await askPrivateKey(io);
  }
  const address = privateKeyToAccount(key).address;
  if (mode === 'import') {
    io.print(`This key belongs to ${address}.`);
    if (!(await askYesNo(io, 'Is this the trading wallet you want to use?', true))) throw new SetupCancelled('Setup cancelled. Nothing was changed.');
  }

  if (existing.exists) {
    const backup = `${keyFile}.bak-${timestamp(deps.now())}`;
    renameSync(keyFile, backup);
    io.print(`The previous key file was moved to ${backup}`);
  }
  const warning = writeKeyFile(deps, keyFile, key);
  io.print(`Saved the key to ${keyFile} (readable only by you).`);
  if (warning) io.print(warning);

  if (mode === 'create') {
    io.print('');
    io.print(`Your new trading wallet: ${address}`);
    io.print('Send the NFTs you want to trade and a little ETH (Ethereum) / APE (ApeChain) for gas to this address.');
    io.print('');
    io.print('The key file is the only copy of this wallet\'s key. If you lose it, anything in the wallet is lost.');
    io.print('Anyone who sees the key can take everything in the wallet, so only show it on a screen nobody else can see.');
    if (await askYesNo(io, 'Show the private key once so you can back it up?', false)) {
      io.print('');
      io.print(`Private key: ${key}`);
      io.print('');
      await io.ask('Store it somewhere safe (a password manager), then press Enter to clear the screen. ');
      io.print('\u001b[2J\u001b[3J\u001b[H');
    }
  }
  return { address, firstSetup: !existing.exists };
}

async function limitsStep(io: Prompter): Promise<Limits> {
  io.print('');
  io.print('Step 2 of 4: limits');
  io.print('oswiki-sign refuses anything above these limits, whatever the AI says. "skip" turns buys and offers off on that chain (listing and cancelling still work).');
  const maxBuyEth = await askAmount(io, 'Most one buy or offer may spend on Ethereum, in ETH', '0.05');
  const maxBuyApe = await askAmount(io, 'Most one buy or offer may spend on ApeChain, in APE', '50');
  const minListFloorPct = await askInt(io, 'Refuse listings and accepted offers below this % of the floor', '50', 100);
  const maxTradesPerDay = await askInt(io, 'Most trades per day', '50', 100000);
  io.print('Dry run: previews work, but nothing is signed or sent. Start with it on and turn it off once the previews look right.');
  const dryRun = await askYesNo(io, 'Turn dry run on?', true);
  return { maxBuyEth, maxBuyApe, minListFloorPct, maxTradesPerDay, dryRun };
}

function printConfig(io: Prompter, deps: SetupDeps, entry: ServerEntry): void {
  io.print('');
  io.print('Claude Desktop (claude_desktop_config.json) and Cursor (~/.cursor/mcp.json), inside "mcpServers":');
  io.print(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));
  io.print('');
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
    io.print(claude ? 'The claude command cannot be run safely with this key file path. Run this yourself:' : 'The claude command was not found. Run this yourself:');
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

  io.print('This runs:');
  io.print(printed);
  if (exists) {
    io.print(`Claude Code already has a user-scope "${SERVER_NAME}" server.`);
    if (!(await askYesNo(io, 'Replace it?', true))) {
      io.print('Kept the existing Claude Code entry.');
      return false;
    }
  } else if (!(await askYesNo(io, 'Add it?', true))) {
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
  io.print(`Added ${SERVER_NAME} to Claude Code (user scope, stored in ~/.claude.json).`);
  return true;
}

async function addToJsonConfig(deps: SetupDeps, path: string, label: string, entry: ServerEntry): Promise<boolean> {
  const { io } = deps;
  const config = readJsonObject(path, `The ${label} config`);
  const servers = config?.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new SetupError(`"mcpServers" in ${path} is not an object. Nothing was changed.`);
  }
  io.print(`${config ? 'Adding to' : 'Creating'} ${path}:`);
  io.print(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));
  if (servers && SERVER_NAME in (servers as Json)) io.print(`This replaces the existing "${SERVER_NAME}" entry. Other servers are kept.`);
  if (!(await askYesNo(io, 'Write this?', true))) return false;

  if (config) {
    const backup = backupFile(path, deps.now());
    io.print(`Backed up the original to ${backup}`);
  }
  writeJson(path, { ...(config ?? {}), mcpServers: { ...((servers as Json | undefined) ?? {}), [SERVER_NAME]: entry } });
  io.print(`Saved ${path}`);
  return true;
}

async function hardenClaudeCode(deps: SetupDeps): Promise<void> {
  const { io } = deps;
  const path = join(deps.home, '.claude', 'settings.json');
  io.print('');
  io.print('Step 4 of 4: Claude Code hardening');
  io.print('These deny rules stop the agent from reading the key file and from changing its own setup (limits, confirm mode, MCP servers, hooks):');
  for (const rule of DENY_RULES) io.print(`  ${rule}`);
  if (await askYesNo(io, `Add them to ${path}?`, true)) io.print(addDenyRules(deps, path));
  else io.print('Skipped. See "Claude Code hardening" in the README to add them later.');
  printSandbox(io);
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
  if (missing.length === 0) return 'All rules are already there.';
  const lines: string[] = [];
  if (settings) lines.push(`Backed up the original to ${backupFile(path, deps.now())}`);
  writeJson(path, { ...(settings ?? {}), permissions: { ...((permissions as Json | undefined) ?? {}), deny: [...current, ...missing] } });
  lines.push(`Added ${missing.length} deny rule${missing.length === 1 ? '' : 's'} to ${path}`);
  return lines.join('\n');
}

function printSandbox(io: Prompter): void {
  io.print('');
  io.print('Also turn on the Claude Code sandbox (/sandbox) with ~/.oswiki-sign in its denyRead and denyWrite lists (see "Claude Code hardening" in the README).');
  io.print('Deny rules cover Claude\'s file tools and the shell commands it recognizes, not a script that opens files itself (node -e, python -c); the sandbox closes that gap.');
  io.print('It runs on macOS, Linux and WSL2. On native Windows commands run unsandboxed, so run Claude Code inside WSL2 if you trade with it on Windows.');
}

async function flow(deps: SetupDeps): Promise<void> {
  const { io } = deps;
  const keyFile = keyFilePath(deps.home);
  io.print(`oswiki-sign ${deps.version} setup`);
  io.print('This creates or imports a trading wallet, sets its limits and adds oswiki-sign to your AI client.');
  io.print('Use a separate trading wallet that only holds what you are willing to trade, never your main wallet.');

  const wallet = await walletStep(deps, keyFile);
  const limits = await limitsStep(io);
  const entry = serverEntry(deps.version, serverEnv(keyFile, limits));

  io.print('');
  io.print('Step 3 of 4: AI client');
  const client = await askChoice<Client>(io, 'Which AI client should run oswiki-sign?', [
    { label: 'Claude Code', value: 'claude-code' },
    { label: 'Cursor', value: 'cursor' },
    { label: 'Claude Desktop', value: 'claude-desktop' },
    { label: 'Just print the config', value: 'print' },
  ], 0);
  io.print('The config holds only the path of the key file, never the key.');

  let configured = false;
  if (client === 'claude-code') configured = await addToClaudeCode(deps, entry);
  else if (client === 'cursor') configured = await addToJsonConfig(deps, cursorConfigPath(deps.home), 'Cursor', entry);
  else if (client === 'claude-desktop') configured = await addToJsonConfig(deps, claudeDesktopConfigPath(deps.platform, deps.home, deps.env), 'Claude Desktop', entry);
  else printConfig(io, deps, entry);

  if (client === 'claude-code') await hardenClaudeCode(deps);
  else {
    io.print('');
    io.print('Step 4 of 4: hardening');
    io.print(`Make sure the agent in your client cannot read ${dirname(keyFile)} or edit its MCP config; see "Claude Code hardening" in the README for the idea.`);
  }

  const clientName = { 'claude-code': 'Claude Code', cursor: 'Cursor', 'claude-desktop': 'Claude Desktop', print: 'your AI client' }[client];
  io.print('');
  io.print('Done.');
  io.print(`Wallet: ${wallet.address}`);
  io.print(`Key file: ${keyFile}`);
  io.print(`Dry run: ${limits.dryRun ? 'on (nothing is signed or sent)' : 'OFF (trades are signed and sent after your confirmation)'}`);
  io.print('');
  io.print('Next steps:');
  io.print(`  1. ${configured ? `Restart ${clientName}` : `Add the config to ${clientName}, then restart it`}.`);
  io.print('  2. Ask: "wallet status".');
  io.print('  3. Keep the hosted OSWiki MCP (https://mcp.oswiki.xyz/mcp) installed too: the AI uses it to look up collections, floors and listings.');
  if (limits.dryRun) {
    io.print(`  4. When the dry-run previews look right, turn dry run off: run setup again (it keeps your wallet) or set OSWIKI_DRY_RUN to 0 in the ${SERVER_NAME} config, then restart the client.`);
  }
  if (wallet.firstSetup) io.print('Never paste the private key into a chat. oswiki-sign never asks for it, and the AI must not either.');
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
  };
}
