import { parseEventLogs, type Address, type Hex, type Log } from 'viem';

import { CONDUIT_RESTRICTION_ERRORS, SEAPORT_ERROR_SELECTORS, SEAPORT_EVENTS_ABI, type SeaportAdvancedOrder } from '../abi.js';
import { SEAPORT_ADDRESS, ZERO_ADDRESS, ZERO_BYTES32 } from '../constants.js';
import { parseOrderParameters } from './order.js';

export class OswikiOrderGuardError extends Error {
  constructor(reason: string) {
    super(`OSWiki order rejected: ${reason}. Nothing was sent.`);
    this.name = 'OswikiOrderGuardError';
  }
}

export interface BuyData {
  askId?: unknown;
  to?: unknown;
  value?: unknown;
  orderData?: unknown;
}

export interface OswikiOrderExpectation {
  tokenId?: string | null;
  contract?: string | null;
}

export interface GuardedSeaportOrder {
  order: SeaportAdvancedOrder;
  value: bigint;
}

const SIGNATURE_RE = /^0x([0-9a-fA-F]{2})+$/;

function smallUint(value: unknown, fallback: bigint): bigint | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Strict read of the AdvancedOrder shape {parameters, signature, numerator, denominator, extraData} the API serves for every marketplace. */
export function readAdvancedOrder(raw: unknown, fail: (reason: string) => never): SeaportAdvancedOrder {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('unreadable order data');
  const data = raw as Record<string, unknown>;
  const params = data.parameters as Record<string, unknown> | undefined;
  if (!params || typeof params !== 'object') return fail('unreadable order data');
  let parsed;
  try {
    parsed = parseOrderParameters({
      ...params,
      zoneHash: params.zoneHash ?? ZERO_BYTES32,
      totalOriginalConsiderationItems: params.totalOriginalConsiderationItems ?? (Array.isArray(params.consideration) ? params.consideration.length : undefined),
    });
  } catch (err) {
    return fail((err as Error).message);
  }
  const numerator = smallUint(data.numerator, 1n);
  const denominator = smallUint(data.denominator, 1n);
  if (numerator === null || denominator === null || numerator <= 0n || denominator <= 0n || numerator > denominator) fail('invalid fraction');
  if (typeof data.signature !== 'string' || !SIGNATURE_RE.test(data.signature)) fail('missing signature');
  const extraData = data.extraData === undefined || data.extraData === null ? '0x' : data.extraData;
  if (typeof extraData !== 'string') fail('invalid extraData');
  return {
    parameters: parsed,
    numerator: numerator!,
    denominator: denominator!,
    signature: (data.signature as string).toLowerCase() as Hex,
    extraData: extraData as Hex,
  };
}

/**
 * Buy-side check, run before anything is sent: the calldata is re-encoded locally
 * from this order, never taken from the backend.
 */
export function assertOswikiSeaportOrder(data: BuyData, expected: OswikiOrderExpectation = {}): GuardedSeaportOrder {
  const fail = (reason: string): never => {
    throw new OswikiOrderGuardError(reason);
  };

  if (typeof data.to !== 'string' || data.to.toLowerCase() !== SEAPORT_ADDRESS) fail('target is not Seaport 1.6');
  const advanced = readAdvancedOrder(data.orderData, fail);
  const params = advanced.parameters;

  if (params.zone !== ZERO_ADDRESS || params.zoneHash !== ZERO_BYTES32) fail('zone must be 0');
  if (params.orderType !== 0 && params.orderType !== 1) fail('orderType must be FULL_OPEN or PARTIAL_OPEN');
  if (params.offer.length !== 1) fail('exactly one offer item required');

  const item = params.offer[0]!;
  if (item.itemType !== 2 && item.itemType !== 3) fail('offer item must be an ERC-721 or ERC-1155');
  if (item.token === ZERO_ADDRESS) fail('offer token missing');
  if (item.startAmount <= 0n || item.startAmount !== item.endAmount) fail('offer amount must be fixed');
  if (item.itemType === 2 && item.startAmount !== 1n) fail('ERC-721 offer must be one unit');

  if (expected.tokenId != null && expected.tokenId !== '' && (!/^\d+$/.test(expected.tokenId) || item.identifierOrCriteria !== BigInt(expected.tokenId))) fail('offer is not the expected NFT');
  if (expected.contract && item.token !== expected.contract.toLowerCase()) fail('offer is not the expected collection');

  if (params.consideration.length === 0) fail('empty consideration');
  for (const c of params.consideration) {
    if (c.itemType !== 0 || c.token !== ZERO_ADDRESS || c.identifierOrCriteria !== 0n) fail('consideration must be native');
    if (c.startAmount <= 0n || c.startAmount !== c.endAmount) fail('consideration amounts must be fixed');
  }
  if (params.consideration[0]!.recipient !== params.offerer) fail('first payment must go to the seller');
  if (params.totalOriginalConsiderationItems !== BigInt(params.consideration.length)) fail('totalOriginalConsiderationItems mismatch');

  const { numerator, denominator } = advanced;
  if (numerator !== denominator) {
    if (params.orderType !== 1) fail('only PARTIAL_OPEN orders take a fraction');
    if (denominator !== item.startAmount) fail('fraction must be over the listed quantity');
  }
  for (const amount of [item.startAmount, ...params.consideration.map(c => c.startAmount)]) {
    if ((amount * numerator) % denominator !== 0n) fail('inexact fraction');
  }

  const total = params.consideration.reduce((sum, c) => sum + c.startAmount, 0n);
  const value = (total * numerator) / denominator;
  const sentValue = data.value === undefined || data.value === null ? '' : String(data.value);
  if (!/^\d+$/.test(sentValue) || BigInt(sentValue) !== value) fail('value is not the exact order total');
  if (advanced.extraData !== '0x') fail('zone-0 orders carry no extraData');

  return { order: advanced, value };
}

/** askIds are the Seaport struct hash, bare (OpenSea) or prefixed 'oswiki-' / 'gondi-'. */
export function orderHashFromAskId(askId: string | null | undefined): Hex | null {
  const match = /^(?:(?:oswiki|gondi)-)?(0x[0-9a-fA-F]{64})$/.exec(askId ?? '');
  return match ? match[1]!.toLowerCase() as Hex : null;
}

export function extractRevertData(err: unknown): Hex | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    const e = current as { raw?: unknown; data?: unknown; cause?: unknown };
    const nested = e.data && typeof e.data === 'object' ? (e.data as { data?: unknown }).data : undefined;
    for (const candidate of [e.raw, e.data, nested]) {
      if (typeof candidate === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) return candidate as Hex;
    }
    current = e.cause;
  }
  return null;
}

export function revertName(err: unknown): string | null {
  const data = extractRevertData(err);
  if (data) {
    const name = SEAPORT_ERROR_SELECTORS[data.slice(0, 10).toLowerCase()];
    if (name) return name;
  }
  const message = `${(err as { message?: string } | null)?.message ?? ''} ${(err as { shortMessage?: string } | null)?.shortMessage ?? ''}`;
  return Object.values(SEAPORT_ERROR_SELECTORS).find(name => message.includes(name)) ?? null;
}

export function isConduitRestriction(err: unknown): boolean {
  const name = revertName(err);
  return name !== null && CONDUIT_RESTRICTION_ERRORS.has(name);
}

export function revertMessage(err: unknown): string {
  const name = revertName(err);
  switch (name) {
    case 'OrderAlreadyFilled':
    case 'OrderPartiallyFilled': return 'the order was already filled';
    case 'OrderIsCancelled': return 'the order was cancelled';
    case 'InvalidTime': return 'the order has expired or is not active yet';
    case 'InvalidSigner':
    case 'InvalidSignature':
    case 'BadSignatureV':
    case 'BadContractSignature': return 'the order signature is no longer valid';
    case 'TokenTransferGenericFailure':
    case 'NoContract':
    case 'ChannelClosed':
    case 'InvalidCallToConduit': return 'the NFT or token could not be transferred (no longer held, or approval revoked)';
    case 'InsufficientNativeTokensSupplied':
    case 'InvalidMsgValue': return 'the payment amount does not match the order';
    case null: return 'the simulation reverted';
    default: return CONDUIT_RESTRICTION_ERRORS.has(name) ? 'this collection blocks transfers through the OpenSea conduit' : `the simulation reverted (${name})`;
  }
}

export interface FilledOrder {
  received: bigint;
  paid: bigint;
}

/** Per order hash: units of the expected NFT delivered and the amount paid (native or wrapped), as Seaport executed them. */
export function filledOrders(logs: Log[], nfts: ReadonlyMap<string, { token: Address; identifier: bigint }>): Map<string, FilledOrder> {
  const result = new Map<string, FilledOrder>();
  for (const log of parseEventLogs({ abi: SEAPORT_EVENTS_ABI, eventName: 'OrderFulfilled', logs })) {
    if (log.address.toLowerCase() !== SEAPORT_ADDRESS) continue;
    const hash = log.args.orderHash.toLowerCase();
    const nft = nfts.get(hash);
    if (!nft) continue;
    const received = log.args.offer
      .filter(item => item.token.toLowerCase() === nft.token.toLowerCase() && item.identifier === nft.identifier)
      .reduce((sum, item) => sum + item.amount, 0n);
    const paid = log.args.consideration.filter(item => item.itemType === 0 || item.itemType === 1).reduce((sum, item) => sum + item.amount, 0n);
    const prior = result.get(hash);
    result.set(hash, { received: (prior?.received ?? 0n) + received, paid: (prior?.paid ?? 0n) + paid });
  }
  return result;
}

export function cancelledOrderHashes(logs: Log[]): Set<string> {
  return new Set(parseEventLogs({ abi: SEAPORT_EVENTS_ABI, eventName: 'OrderCancelled', logs })
    .filter(log => log.address.toLowerCase() === SEAPORT_ADDRESS)
    .map(log => log.args.orderHash.toLowerCase()));
}

/** The bid's own OrderFulfilled, matched on the bid hash and the NFT it received (consideration[0]). */
export function findOfferFulfilledEvent(logs: Log[], bidHash: string, nft: { token: Address; identifier: bigint }): boolean {
  const hash = bidHash.toLowerCase();
  return parseEventLogs({ abi: SEAPORT_EVENTS_ABI, eventName: 'OrderFulfilled', logs })
    .some(log => log.address.toLowerCase() === SEAPORT_ADDRESS
      && log.args.orderHash.toLowerCase() === hash
      && log.args.consideration[0]?.token.toLowerCase() === nft.token.toLowerCase()
      && log.args.consideration[0]?.identifier === nft.identifier);
}
