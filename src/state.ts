import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { APECHAIN_ID, MAINNET_ID, NATIVE_SYMBOL, SUPPORTED_CHAINS, type SupportedChainId } from './constants.js';
import { native } from './format.js';

export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const STATE_VERSION = 2;
const UNKEYED_MAC_KEY = createHash('sha256').update('oswiki-sign/state/unkeyed').digest();
const HASH_RE = /^0x[0-9a-f]{64}$/;
const WEI_RE = /^\d{1,78}$/;

export interface PendingTx {
  chainId: SupportedChainId;
  hash: `0x${string}`;
  nonce: number;
  label: string;
  sentAt: number;
}

export interface Charge {
  chainId: SupportedChainId;
  trades?: number;
  cancels?: number;
  spendWei?: bigint;
}

export interface Limits {
  maxTrades: number;
  maxCancels: number;
  dailyMaxWei: Record<SupportedChainId, bigint | null>;
}

export interface Usage {
  day: string;
  trades: number;
  cancels: number;
  spentWei: Record<SupportedChainId, bigint>;
  tampered: boolean;
}

interface Stored extends Usage {
  pending: PendingTx[];
}

export class DailyCapError extends Error {
  constructor(message: string) {
    super(`${message} Nothing was signed or sent.`);
    this.name = 'DailyCapError';
  }
}

export class StateLockError extends Error {
  constructor() {
    super('The trade state is locked by another oswiki-sign process. Try again in a moment. Nothing was signed or sent.');
    this.name = 'StateLockError';
  }
}

const CHAIN_NAME: Record<SupportedChainId, string> = { [MAINNET_ID]: 'Ethereum', [APECHAIN_ID]: 'ApeChain' };

function zeroSpent(): Record<SupportedChainId, bigint> {
  return { [MAINNET_ID]: 0n, [APECHAIN_ID]: 0n };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPending(value: unknown): value is PendingTx {
  const entry = value as Partial<PendingTx> | null;
  return entry !== null && typeof entry === 'object'
    && SUPPORTED_CHAINS.includes(entry.chainId as SupportedChainId)
    && typeof entry.hash === 'string' && HASH_RE.test(entry.hash)
    && isCount(entry.nonce) && isCount(entry.sentAt)
    && typeof entry.label === 'string' && entry.label.length <= 80;
}

/**
 * Daily usage per UTC day in <stateDir>/state.json, MAC'd with a key derived from the wallet key: a file the
 * MAC does not verify counts as every cap used up. Writes are atomic and serialized across processes by a lock file.
 */
export class TradeState {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly macKey: Uint8Array;
  private memory: Usage | null = null;

  constructor(private readonly dir: string, private readonly max: number, private readonly now: () => number = Date.now, options: { macKey?: Uint8Array } = {}) {
    this.file = join(dir, 'state.json');
    this.lockFile = join(dir, 'state.lock');
    this.macKey = options.macKey ?? UNKEYED_MAC_KEY;
  }

  usage(): Usage {
    return this.effective(this.read());
  }

  tradesToday(): number {
    return this.usage().trades;
  }

  cancelsToday(): number {
    return this.usage().cancels;
  }

  spentToday(chainId: SupportedChainId): bigint {
    return this.usage().spentWei[chainId];
  }

  remaining(): number {
    return Math.max(0, this.max - this.tradesToday());
  }

  isTampered(): boolean {
    return this.read().tampered;
  }

  assertAvailable(): void {
    this.check({ chainId: MAINNET_ID, trades: 1 }, this.defaultLimits());
  }

  check(charge: Charge, limits: Limits = this.defaultLimits()): void {
    assertWithin(this.usage(), charge, limits);
  }

  /** Called right before the first irreversible step of an execute: checks and books the charge under the lock. */
  record(charge: Charge = { chainId: MAINNET_ID, trades: 1 }, limits: Limits = this.defaultLimits()): void {
    this.locked(() => {
      const stored = this.read();
      const usage = this.effective(stored);
      assertWithin(usage, charge, limits);
      const spentWei = { ...usage.spentWei };
      spentWei[charge.chainId] += charge.spendWei ?? 0n;
      const next: Usage = { day: usage.day, trades: usage.trades + (charge.trades ?? 0), cancels: usage.cancels + (charge.cancels ?? 0), spentWei, tampered: false };
      this.write({ ...next, pending: stored.pending });
      this.memory = next;
    });
  }

  pendingTxs(chainId?: SupportedChainId): PendingTx[] {
    const pending = this.read().pending;
    return chainId === undefined ? pending : pending.filter(entry => entry.chainId === chainId);
  }

  addPending(entry: PendingTx): void {
    const hash = entry.hash.toLowerCase() as PendingTx['hash'];
    this.updatePending(pending => [...pending.filter(item => item.hash !== hash), { ...entry, hash }]);
  }

  removePending(hash: string): void {
    this.updatePending(pending => pending.filter(item => item.hash !== hash.toLowerCase()));
  }

  private updatePending(change: (pending: PendingTx[]) => PendingTx[]): void {
    this.locked(() => {
      const stored = this.read();
      if (stored.tampered) return;
      this.write({ ...stored, pending: change(stored.pending) });
    });
  }

  private defaultLimits(): Limits {
    return { maxTrades: this.max, maxCancels: Number.MAX_SAFE_INTEGER, dailyMaxWei: { [MAINNET_ID]: null, [APECHAIN_ID]: null } };
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** The higher of file and this process's own bookings, so deleting the file mid-session resets nothing here. */
  private effective(stored: Stored): Usage {
    const today = this.today();
    const fromFile: Usage = stored.tampered || stored.day === today
      ? { day: today, trades: stored.trades, cancels: stored.cancels, spentWei: stored.spentWei, tampered: stored.tampered }
      : { day: today, trades: 0, cancels: 0, spentWei: zeroSpent(), tampered: false };
    const mem = this.memory?.day === today ? this.memory : null;
    if (!mem) return fromFile;
    const spentWei = zeroSpent();
    for (const chainId of SUPPORTED_CHAINS) spentWei[chainId] = fromFile.spentWei[chainId] > mem.spentWei[chainId] ? fromFile.spentWei[chainId] : mem.spentWei[chainId];
    return { day: today, trades: Math.max(fromFile.trades, mem.trades), cancels: Math.max(fromFile.cancels, mem.cancels), spentWei, tampered: fromFile.tampered };
  }

  private mac(body: string): string {
    return createHmac('sha256', this.macKey).update(body).digest('hex');
  }

  private body(state: Stored): string {
    return JSON.stringify({
      v: STATE_VERSION,
      day: state.day,
      trades: state.trades,
      cancels: state.cancels,
      spent: Object.fromEntries(SUPPORTED_CHAINS.map(chainId => [String(chainId), state.spentWei[chainId].toString()])),
      pending: state.pending.map(entry => ({ chainId: entry.chainId, hash: entry.hash, nonce: entry.nonce, label: entry.label, sentAt: entry.sentAt })),
    });
  }

  private write(state: Stored): void {
    const body = this.body(state);
    atomicWrite(this.dir, this.file, `${body.slice(0, -1)},"mac":"${this.mac(body)}"}`);
  }

  private tampered(): Stored {
    const max = BigInt(Number.MAX_SAFE_INTEGER) * 10n ** 18n;
    return { day: this.today(), trades: Number.MAX_SAFE_INTEGER, cancels: Number.MAX_SAFE_INTEGER, spentWei: { [MAINNET_ID]: max, [APECHAIN_ID]: max }, tampered: true, pending: [] };
  }

  private read(): Stored {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { day: '', trades: 0, cancels: 0, spentWei: zeroSpent(), tampered: false, pending: [] };
      return this.tampered();
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return this.tampered();
    }
    const spent = parsed.spent as Record<string, unknown> | undefined;
    if (
      parsed === null || typeof parsed !== 'object' || parsed.v !== STATE_VERSION || typeof parsed.day !== 'string'
      || !isCount(parsed.trades) || !isCount(parsed.cancels) || typeof parsed.mac !== 'string'
      || spent === null || typeof spent !== 'object' || !SUPPORTED_CHAINS.every(chainId => typeof spent[String(chainId)] === 'string' && WEI_RE.test(spent[String(chainId)] as string))
      || !Array.isArray(parsed.pending) || !parsed.pending.every(isPending)
    ) return this.tampered();
    const state: Stored = {
      day: parsed.day,
      trades: parsed.trades,
      cancels: parsed.cancels,
      spentWei: { [MAINNET_ID]: BigInt(spent[String(MAINNET_ID)] as string), [APECHAIN_ID]: BigInt(spent[String(APECHAIN_ID)] as string) },
      tampered: false,
      pending: parsed.pending as PendingTx[],
    };
    const expected = Buffer.from(this.mac(this.body(state)), 'hex');
    const given = Buffer.from(parsed.mac, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return this.tampered();
    return state;
  }

  private locked<T>(task: () => T): T {
    return withFileLock(this.dir, this.lockFile, task);
  }
}

export function atomicWrite(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Serializes a task across processes with an O_EXCL lock file; a lock older than LOCK_STALE_MS is taken over. */
export function withFileLock<T>(dir: string, lockFile: string, task: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      writeSync(fd, `${process.pid} ${Date.now()}`);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new StateLockError();
      sleepSync(25);
    }
  }
  try {
    return task();
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function assertWithin(usage: Usage, charge: Charge, limits: Limits): void {
  if (usage.tampered) {
    throw new DailyCapError('The trade state file (~/.oswiki-sign/state.json) failed its integrity check, so every daily limit counts as used. If you changed the wallet key, delete that file to reset it.');
  }
  const trades = charge.trades ?? 0;
  if (trades > 0 && usage.trades + trades > limits.maxTrades) {
    throw new DailyCapError(`Daily trade limit reached: ${usage.trades} of ${limits.maxTrades} used today and this needs ${trades} more (OSWIKI_MAX_TRADES_PER_DAY; every listed, bought, offered or accepted item counts).`);
  }
  const cancels = charge.cancels ?? 0;
  if (cancels > 0 && usage.cancels + cancels > limits.maxCancels) {
    throw new DailyCapError(`Daily cancel limit reached: ${usage.cancels} of ${limits.maxCancels} used today and this needs ${cancels} more (OSWIKI_MAX_CANCELS_PER_DAY).`);
  }
  const spend = charge.spendWei ?? 0n;
  if (spend > 0n) {
    const cap = limits.dailyMaxWei[charge.chainId];
    const variable = `OSWIKI_DAILY_MAX_${NATIVE_SYMBOL[charge.chainId]}`;
    if (cap === null) throw new DailyCapError(`No daily spend limit is set on ${CHAIN_NAME[charge.chainId]} (${variable}).`);
    const spent = usage.spentWei[charge.chainId];
    if (spent + spend > cap) {
      throw new DailyCapError(`Daily spend limit on ${CHAIN_NAME[charge.chainId]}: ${native(spent, charge.chainId)} used today plus ${native(spend, charge.chainId)} would exceed ${native(cap, charge.chainId)} (${variable}; buys and new offers count).`);
    }
  }
}
