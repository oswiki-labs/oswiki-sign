import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseUnits } from 'viem';

import { APECHAIN_ID, DEFAULT_RPC, MAINNET_ID, type SupportedChainId } from './constants.js';

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

export type ConfirmMode = 'human' | 'ai' | 'off';

export interface Config {
  rpc: Record<SupportedChainId, string>;
  apiKey: string | null;
  maxBuyWei: Record<SupportedChainId, bigint | null>;
  dailyMaxWei: Record<SupportedChainId, bigint | null>;
  minListFloorPct: number;
  maxTradesPerDay: number;
  maxCancelsPerDay: number;
  maxFeePerGasWei: Record<SupportedChainId, bigint>;
  allowedCollections: ReadonlySet<string> | null;
  blockedCollections: ReadonlySet<string> | null;
  confirmMode: ConfirmMode;
  dryRun: boolean;
  stateDir: string;
}

export const DEFAULT_MAX_GWEI: Record<SupportedChainId, string> = { [MAINNET_ID]: '200', [APECHAIN_ID]: '1000' };
export const DEFAULT_MAX_CANCELS_PER_DAY = 200;

const DECIMAL_RE = /^(\d+)(\.\d{1,18})?$/;
const GWEI_RE = /^(\d+)(\.\d{1,9})?$/;
const INT_RE = /^\d{1,15}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function readUrl(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined || value.trim() === '') return fallback;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SetupError(`${name} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new SetupError(`${name} must use https (http is only allowed for localhost).`);
  }
  return url.toString();
}

function readCap(value: string | undefined, name: string): bigint | null {
  if (value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) throw new SetupError(`${name} must be a decimal amount like 0.5.`);
  return parseUnits(trimmed, 18);
}

function readInt(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const trimmed = value.trim();
  const parsed = INT_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new SetupError(`${name} must be a whole number from ${min} to ${max}.`);
  return parsed;
}

function readGwei(value: string | undefined, fallback: string, name: string): bigint {
  const trimmed = value === undefined || value.trim() === '' ? fallback : value.trim();
  if (!GWEI_RE.test(trimmed)) throw new SetupError(`${name} must be a gas price in gwei like 50.`);
  const wei = parseUnits(trimmed, 9);
  if (wei <= 0n || wei > parseUnits('100000', 9)) throw new SetupError(`${name} must be more than 0 and at most 100000 gwei.`);
  return wei;
}

function readConfirmMode(value: string | undefined): ConfirmMode {
  const mode = value?.trim().toLowerCase() ?? '';
  if (mode === '' || mode === 'human') return 'human';
  if (mode === 'ai') return 'ai';
  if (mode === 'off') return 'off';
  throw new SetupError('OSWIKI_CONFIRM_MODE must be "human" (default), "ai" or "off".');
}

function readAddresses(value: string | undefined, name: string): Set<string> | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const entries = trimmed.split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.some(entry => !ADDRESS_RE.test(entry))) throw new SetupError(`${name} must be a comma-separated list of 0x collection addresses.`);
  return new Set(entries.map(entry => entry.toLowerCase()));
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const allowedCollections = readAddresses(env.OSWIKI_ALLOWED_COLLECTIONS, 'OSWIKI_ALLOWED_COLLECTIONS');
  const blockedCollections = readAddresses(env.OSWIKI_BLOCKED_COLLECTIONS, 'OSWIKI_BLOCKED_COLLECTIONS');

  const dryRunRaw = env.OSWIKI_DRY_RUN?.trim().toLowerCase();
  const apiKey = env.OSWIKI_API_KEY?.trim();
  const maxBuyWei: Record<SupportedChainId, bigint | null> = {
    [MAINNET_ID]: readCap(env.OSWIKI_MAX_BUY_ETH, 'OSWIKI_MAX_BUY_ETH'),
    [APECHAIN_ID]: readCap(env.OSWIKI_MAX_BUY_APE, 'OSWIKI_MAX_BUY_APE'),
  };
  const dailyMax = (value: string | undefined, name: string, perTrade: bigint | null) => readCap(value, name) ?? (perTrade === null ? null : perTrade * 3n);

  return {
    rpc: {
      [MAINNET_ID]: readUrl(env.OSWIKI_RPC_URL_MAINNET, DEFAULT_RPC[MAINNET_ID], 'OSWIKI_RPC_URL_MAINNET'),
      [APECHAIN_ID]: readUrl(env.OSWIKI_RPC_URL_APECHAIN, DEFAULT_RPC[APECHAIN_ID], 'OSWIKI_RPC_URL_APECHAIN'),
    },
    apiKey: apiKey ? apiKey : null,
    maxBuyWei,
    dailyMaxWei: {
      [MAINNET_ID]: dailyMax(env.OSWIKI_DAILY_MAX_ETH, 'OSWIKI_DAILY_MAX_ETH', maxBuyWei[MAINNET_ID]),
      [APECHAIN_ID]: dailyMax(env.OSWIKI_DAILY_MAX_APE, 'OSWIKI_DAILY_MAX_APE', maxBuyWei[APECHAIN_ID]),
    },
    minListFloorPct: readInt(env.OSWIKI_MIN_LIST_FLOOR_PCT, 50, 'OSWIKI_MIN_LIST_FLOOR_PCT', 0, 100),
    maxTradesPerDay: readInt(env.OSWIKI_MAX_TRADES_PER_DAY, 50, 'OSWIKI_MAX_TRADES_PER_DAY', 0, 100000),
    maxCancelsPerDay: readInt(env.OSWIKI_MAX_CANCELS_PER_DAY, DEFAULT_MAX_CANCELS_PER_DAY, 'OSWIKI_MAX_CANCELS_PER_DAY', 0, 100000),
    maxFeePerGasWei: {
      [MAINNET_ID]: readGwei(env.OSWIKI_MAX_GWEI, DEFAULT_MAX_GWEI[MAINNET_ID], 'OSWIKI_MAX_GWEI'),
      [APECHAIN_ID]: readGwei(env.OSWIKI_MAX_GWEI_APECHAIN, DEFAULT_MAX_GWEI[APECHAIN_ID], 'OSWIKI_MAX_GWEI_APECHAIN'),
    },
    allowedCollections,
    blockedCollections,
    confirmMode: readConfirmMode(env.OSWIKI_CONFIRM_MODE),
    dryRun: dryRunRaw === '1' || dryRunRaw === 'true' || dryRunRaw === 'yes',
    stateDir: env.OSWIKI_SIGN_STATE_DIR?.trim() || join(homedir(), '.oswiki-sign'),
  };
}
