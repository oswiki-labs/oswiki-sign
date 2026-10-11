import type { Address } from 'viem';

import { encodeFulfillAdvancedOrder } from '../abi.js';
import { OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, ZERO_ADDRESS, ZERO_BYTES32 } from '../constants.js';
import { readAdvancedOrder, type BuyData, type GuardedSeaportOrder } from './fulfill.js';
import { OPENSEA_SIGNED_ZONE } from './opensea.js';

export class OpenSeaOrderGuardError extends Error {
  constructor(reason: string) {
    super(`OpenSea order rejected: ${reason}. Nothing was sent.`);
    this.name = 'OpenSeaOrderGuardError';
  }
}

export interface OpenSeaBuyData extends BuyData {
  marketplace?: unknown;
  data?: unknown;
  priceWei?: unknown;
  expectedItem?: unknown;
}

export interface OpenSeaOrderExpectation {
  contract: string;
  tokenId: string;
  wallet: Address;
  nowSeconds: bigint;
}

const SELLER_CONDUIT_KEYS: ReadonlySet<string> = new Set([ZERO_BYTES32, OPENSEA_CONDUIT_KEY]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decimal(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * Buy-side check of an OpenSea listing served by the OSWiki API. OpenSea fee and royalty
 * layouts are the seller's business: only what the buyer pays and receives is pinned.
 * The struct hash against the askId is checked by the caller with the live counter.
 */
export function assertOpenSeaSeaportOrder(data: OpenSeaBuyData, expected: OpenSeaOrderExpectation): GuardedSeaportOrder & { quantity: bigint } {
  const fail = (reason: string): never => {
    throw new OpenSeaOrderGuardError(reason);
  };

  if (data.marketplace !== 'opensea') fail('not served as an OpenSea listing');
  if (typeof data.to !== 'string' || data.to.toLowerCase() !== SEAPORT_ADDRESS) fail('target is not Seaport 1.6');
  const advanced = readAdvancedOrder(data.orderData, fail);
  const params = advanced.parameters;

  if (params.orderType > 3) fail('contract orders cannot be bought');
  const restricted = params.orderType >= 2;
  if (restricted) {
    if (params.zone !== OPENSEA_SIGNED_ZONE) fail('restricted order outside OpenSea\'s SignedZone');
    if (advanced.extraData === '0x') fail('restricted order without the zone authorization');
  }
  if (!SELLER_CONDUIT_KEYS.has(params.conduitKey)) fail('unknown seller conduit');

  if (params.offer.length !== 1) fail('exactly one offer item required');
  const item = params.offer[0]!;
  if (item.itemType !== 2 && item.itemType !== 3) fail('offer item must be an ERC-721 or ERC-1155');
  if (item.token === ZERO_ADDRESS) fail('offer token missing');
  if (item.startAmount <= 0n || item.startAmount !== item.endAmount) fail('offer amount must be fixed');
  if (item.itemType === 2 && item.startAmount !== 1n) fail('ERC-721 offer must be one unit');
  if (!/^\d+$/.test(expected.tokenId) || item.identifierOrCriteria !== BigInt(expected.tokenId)) fail('offer is not the expected NFT');
  if (item.token !== expected.contract.toLowerCase()) fail('offer is not the expected collection');

  if (params.consideration.length === 0) fail('empty consideration');
  for (const c of params.consideration) {
    if (c.itemType !== 0 || c.token !== ZERO_ADDRESS || c.identifierOrCriteria !== 0n) fail('consideration must be native');
    if (c.startAmount <= 0n || c.startAmount !== c.endAmount) fail('consideration amounts must be fixed');
  }
  if (params.totalOriginalConsiderationItems !== BigInt(params.consideration.length)) fail('totalOriginalConsiderationItems mismatch');

  const { numerator, denominator } = advanced;
  if (numerator !== denominator && params.orderType !== 1 && params.orderType !== 3) fail('only partial orders take a fraction');
  for (const amount of [item.startAmount, ...params.consideration.map(c => c.startAmount)]) {
    if ((amount * numerator) % denominator !== 0n) fail('inexact fraction');
  }
  const quantity = (item.startAmount * numerator) / denominator;
  const value = (params.consideration.reduce((sum, c) => sum + c.startAmount, 0n) * numerator) / denominator;

  const sentValue = decimal(data.value);
  if (sentValue === null || sentValue !== value) fail('value is not the exact order total');
  if (data.priceWei !== undefined && decimal(data.priceWei) !== value) fail('priceWei is not the exact order total');

  const shown = record(data.expectedItem);
  if (!shown
    || typeof shown.contract !== 'string' || shown.contract.toLowerCase() !== item.token
    || decimal(shown.tokenId) !== item.identifierOrCriteria
    || decimal(shown.amount) !== quantity
    || decimal(shown.itemType) !== BigInt(item.itemType)) fail('expectedItem does not match the order');

  if (params.startTime > expected.nowSeconds) fail('the order is not active yet');
  if (params.endTime <= expected.nowSeconds) fail('the order has expired');

  const fill = record(data.orderData)!;
  if (typeof fill.recipient !== 'string' || fill.recipient.toLowerCase() !== expected.wallet.toLowerCase()) fail('the NFT would not go to this wallet');
  if (fill.fulfillerConduitKey !== undefined && fill.fulfillerConduitKey !== null && String(fill.fulfillerConduitKey).toLowerCase() !== ZERO_BYTES32) fail('unexpected fulfiller conduit');

  const order = advanced;
  if (data.data !== undefined && (typeof data.data !== 'string' || data.data.toLowerCase() !== encodeFulfillAdvancedOrder(order, expected.wallet))) fail('the server calldata does not match the order');

  return { order, value, quantity };
}
