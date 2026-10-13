import type { Address } from 'viem';

import { encodeFulfillAdvancedOrder } from '../abi.js';
import { GONDI_FEE_BPS, GONDI_FEE_RECIPIENT, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_ADDRESS, ZERO_BYTES32 } from '../constants.js';
import { readAdvancedOrder, type BuyData, type GuardedSeaportOrder } from './fulfill.js';

export class GondiOrderGuardError extends Error {
  constructor(reason: string) {
    super(`Gondi order rejected: ${reason}. Nothing was sent.`);
    this.name = 'GondiOrderGuardError';
  }
}

export interface GondiBuyData extends BuyData {
  marketplace?: unknown;
  data?: unknown;
  priceWei?: unknown;
  expectedItem?: unknown;
  currency?: unknown;
}

export interface GondiOrderExpectation {
  chainId: number;
  contract: string;
  tokenId: string;
  wallet: Address;
  nowSeconds: bigint;
}

export interface GuardedGondiOrder extends GuardedSeaportOrder {
  quantity: bigint;
  currency: 'native' | 'wrapped';
  costWei: bigint;
  sellerWei: bigint;
  gondiFeeWei: bigint;
  otherFeesWei: bigint;
}

const MAX_LEGS_AFTER_SELLER = 3;
const SIGNATURE_65_RE = /^0x[0-9a-f]{130}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decimal(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * Buy-side check of a Gondi listing: a plain signed Seaport 1.6 order (zone 0, conduitKey 0), seller leg first,
 * then the 0.5% Gondi fee and at most two more legs, all in the native coin (value = total) or all in wrapped
 * native (value 0, paid through an exact allowance to Seaport). The struct hash is checked by the caller.
 */
export function assertGondiSeaportOrder(data: GondiBuyData, expected: GondiOrderExpectation): GuardedGondiOrder {
  const fail = (reason: string): never => {
    throw new GondiOrderGuardError(reason);
  };

  if (data.marketplace !== 'gondi') fail('not served as a Gondi listing');
  if (typeof data.to !== 'string' || data.to.toLowerCase() !== SEAPORT_ADDRESS) fail('target is not Seaport 1.6');
  const advanced = readAdvancedOrder(data.orderData, fail);
  const params = advanced.parameters;
  const offerer = params.offerer;

  if (offerer === ZERO_ADDRESS) fail('offerer missing');
  if (params.zone !== ZERO_ADDRESS || params.zoneHash !== ZERO_BYTES32) fail('zone must be 0');
  if (params.conduitKey !== ZERO_BYTES32) fail('conduitKey must be 0');
  if (params.orderType !== 0 && params.orderType !== 1) fail('orderType must be FULL_OPEN or PARTIAL_OPEN');
  if (params.startTime > expected.nowSeconds) fail('the order is not active yet');
  if (params.endTime <= expected.nowSeconds) fail('the order has expired');

  if (params.offer.length !== 1) fail('exactly one offer item required');
  const item = params.offer[0]!;
  if (item.itemType !== 2 && item.itemType !== 3) fail('offer item must be an ERC-721 or ERC-1155');
  if (item.token === ZERO_ADDRESS) fail('offer token missing');
  if (item.startAmount <= 0n || item.startAmount !== item.endAmount) fail('offer amount must be fixed');
  if (item.itemType === 2 && item.startAmount !== 1n) fail('ERC-721 offer must be one unit');
  if (!/^\d+$/.test(expected.tokenId) || item.identifierOrCriteria !== BigInt(expected.tokenId)) fail('offer is not the expected NFT');
  if (item.token !== expected.contract.toLowerCase()) fail('offer is not the expected collection');

  const legs = params.consideration;
  if (legs.length < 2 || legs.length > 1 + MAX_LEGS_AFTER_SELLER) fail('payments must be the seller, the Gondi fee and at most two more fees');
  if (params.totalOriginalConsiderationItems !== BigInt(legs.length)) fail('totalOriginalConsiderationItems mismatch');
  if (legs[0]!.recipient !== offerer) fail('first payment must go to the seller');
  if (new Set(legs.map(c => c.recipient)).size !== legs.length) fail('payment recipients must be distinct');

  const wrappedToken = WRAPPED_NATIVE[expected.chainId]?.toLowerCase();
  const isWrapped = legs[0]!.itemType === 1;
  if (isWrapped && !wrappedToken) fail('wrapped-native currency unknown for this chain');
  for (const c of legs) {
    const nativeLeg = !isWrapped && c.itemType === 0 && c.token === ZERO_ADDRESS;
    const wrappedLeg = isWrapped && c.itemType === 1 && c.token === wrappedToken;
    if ((!nativeLeg && !wrappedLeg) || c.identifierOrCriteria !== 0n) fail('every payment must be in one currency, the native coin or wrapped native');
    if (c.startAmount <= 0n || c.startAmount !== c.endAmount) fail('payment amounts must be fixed');
  }

  const fullTotal = legs.reduce((sum, c) => sum + c.startAmount, 0n);
  const feeLegs = legs.filter(c => c.recipient === GONDI_FEE_RECIPIENT);
  if (feeLegs.length !== 1) fail('the Gondi fee payment is missing');
  const feeGap = feeLegs[0]!.startAmount * 10000n - fullTotal * BigInt(GONDI_FEE_BPS);
  if (feeGap <= -10000n || feeGap >= 10000n) fail(`the Gondi fee must be ${GONDI_FEE_BPS / 100}% of the price`);

  const { numerator, denominator } = advanced;
  if (numerator !== denominator) {
    if (params.orderType !== 1) fail('only PARTIAL_OPEN orders take a fraction');
    if (denominator !== item.startAmount) fail('fraction must be over the listed quantity');
  }
  for (const amount of [item.startAmount, ...legs.map(c => c.startAmount)]) {
    if ((amount * numerator) % denominator !== 0n) fail('inexact fraction');
  }
  const part = (amount: bigint) => (amount * numerator) / denominator;
  const quantity = part(item.startAmount);
  const costWei = part(fullTotal);
  const sellerWei = part(legs[0]!.startAmount);
  const gondiFeeWei = part(feeLegs[0]!.startAmount);
  const value = isWrapped ? 0n : costWei;

  if (decimal(data.value) !== value) fail(isWrapped ? 'a wrapped-native order takes no value' : 'value is not the exact order total');
  if (decimal(data.priceWei) !== costWei) fail('priceWei is not the exact order total');
  const currency = record(data.currency);
  if (currency) {
    const address = currency.address ?? currency.contract;
    if (typeof address !== 'string' || address.toLowerCase() !== (isWrapped ? wrappedToken : ZERO_ADDRESS)) fail('currency does not match the order');
  }

  const shown = record(data.expectedItem);
  if (!shown
    || typeof shown.contract !== 'string' || shown.contract.toLowerCase() !== item.token
    || decimal(shown.tokenId) !== item.identifierOrCriteria
    || decimal(shown.amount) !== quantity
    || decimal(shown.itemType) !== BigInt(item.itemType)) fail('expectedItem does not match the order');

  if (!SIGNATURE_65_RE.test(advanced.signature)) fail('signature must be 65 bytes');
  if (advanced.extraData !== '0x') fail('zone-0 orders carry no extraData');

  const fill = record(data.orderData)!;
  if (fill.recipient !== undefined && fill.recipient !== null && (typeof fill.recipient !== 'string' || fill.recipient.toLowerCase() !== expected.wallet.toLowerCase())) fail('the NFT would not go to this wallet');
  if (fill.fulfillerConduitKey !== undefined && fill.fulfillerConduitKey !== null && String(fill.fulfillerConduitKey).toLowerCase() !== ZERO_BYTES32) fail('unexpected fulfiller conduit');
  if (data.data !== undefined && (typeof data.data !== 'string' || data.data.toLowerCase() !== encodeFulfillAdvancedOrder(advanced, expected.wallet))) fail('the server calldata does not match the order');

  return {
    order: advanced,
    value,
    quantity,
    currency: isWrapped ? 'wrapped' : 'native',
    costWei,
    sellerWei,
    gondiFeeWei,
    otherFeesWei: costWei - sellerWei - gondiFeeWei,
  };
}
