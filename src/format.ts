import { formatUnits, parseUnits } from 'viem';

import { NATIVE_SYMBOL, WRAPPED_SYMBOL } from './constants.js';

export function trimAmount(wei: bigint, maxDecimals = 6): string {
  const text = formatUnits(wei, 18);
  const [whole, fraction = ''] = text.split('.');
  const cut = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  if (cut === '' && fraction !== '' && /[1-9]/.test(fraction) && whole === '0') return `<0.${'0'.repeat(maxDecimals - 1)}1`;
  return cut ? `${whole}.${cut}` : whole!;
}

export function native(wei: bigint, chainId: number): string {
  return `${trimAmount(wei)} ${NATIVE_SYMBOL[chainId] ?? 'NATIVE'}`;
}

export function wrapped(wei: bigint, chainId: number): string {
  return `${trimAmount(wei)} ${WRAPPED_SYMBOL[chainId] ?? 'WRAPPED'}`;
}

export class PriceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceInputError';
  }
}

const PRICE_RE = /^(\d+)(\.\d{1,18})?$/;
const MAX_NUMBER_DIGITS = 15;

function significantDigits(text: string): number {
  if (!/^-?\d+(\.\d+)?$/.test(text)) return Number.POSITIVE_INFINITY;
  return text.replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;
}

export function shortAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}...${address.slice(-4)}`.toLowerCase() : '?';
}

/** Short form for reading, full form for checking. */
export function addressLabel(address: string): string {
  return `${shortAddress(address)} (${address.toLowerCase()})`;
}

/**
 * An explicit, positive decimal amount. Words like "floor" are never resolved here: the
 * caller must pass a number the user agreed to.
 */
export function parsePositiveAmount(value: unknown, field = 'price'): bigint {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PriceInputError(`${field} must be a positive number, got ${String(value)}.`);
    text = value.toString();
    if (!Number.isSafeInteger(value) && significantDigits(text) > MAX_NUMBER_DIGITS) {
      throw new PriceInputError(`${field} ${text} cannot be represented exactly as a number. Pass it as a decimal string like "1.25".`);
    }
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new PriceInputError(`${field} is required and must be a positive decimal number.`);
  }
  if (!PRICE_RE.test(text)) throw new PriceInputError(`${field} must be a positive decimal number like 1.25 (got "${text.slice(0, 40)}"). A floor or other reference is never filled in automatically.`);
  const wei = parseUnits(text, 18);
  if (wei <= 0n) throw new PriceInputError(`${field} must be greater than 0.`);
  return wei;
}

export function ageLabel(timestamp: string | null, nowMs: number): { label: string; days: number | null } {
  if (!timestamp) return { label: 'date unknown', days: null };
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return { label: 'date unknown', days: null };
  const days = Math.max(0, Math.floor((nowMs - at) / 86_400_000));
  if (days === 0) return { label: 'today', days };
  return { label: `${days}d ago`, days };
}

export const CONFIRM_FOOTER = (confirmId: string) => `Ask the user to confirm, then call execute with confirmId ${confirmId}.`;
