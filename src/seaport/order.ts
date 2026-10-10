import { randomBytes as nodeRandomBytes } from 'node:crypto';

import type { Address, Hex } from 'viem';

import { OPENSEA_CONDUIT_KEY, ZERO_ADDRESS, ZERO_BYTES32 } from '../constants.js';

export const SEAPORT_ITEM_TYPE = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3, ERC721_WITH_CRITERIA: 4 } as const;
export const SEAPORT_ORDER_TYPE = { FULL_OPEN: 0, PARTIAL_OPEN: 1 } as const;

export const OSWIKI_SALT_MARKER = BigInt(0x4f535749);
export const LISTING_START_SKEW_SECONDS = 60;
export const MIN_LISTING_DURATION_SECONDS = 3600;
export const MAX_LISTING_DURATION_SECONDS = 365 * 24 * 3600;

export interface SeaportOfferItem {
  itemType: number;
  token: Address;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}

export interface SeaportConsiderationItem extends SeaportOfferItem {
  recipient: Address;
}

export interface OrderComponents {
  offerer: Address;
  zone: Address;
  offer: SeaportOfferItem[];
  consideration: SeaportConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  conduitKey: Hex;
  counter: bigint;
}

export interface SeaportOrderParameters {
  offerer: string;
  zone: string;
  offer: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string }>;
  consideration: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string }>;
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
  totalOriginalConsiderationItems: number;
}

export interface SeaportSaleAmounts {
  total: bigint;
  fee: bigint;
  royalty: bigint;
  royaltyRecipient: Address | null;
  seller: bigint;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;

function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw new Error(`Invalid ${field}`);
  return value.toLowerCase() as Address;
}

function parseBytes32(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !BYTES32_RE.test(value)) throw new Error(`Invalid ${field}`);
  return value.toLowerCase() as Hex;
}

function parseUint(value: unknown, field: string): bigint {
  let parsed: bigint | null = null;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && UINT_RE.test(value)) parsed = BigInt(value);
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256) throw new Error(`Invalid ${field}`);
  return parsed;
}

function parseSmallInt(value: unknown, field: string): number {
  const parsed = parseUint(value, field);
  if (parsed > 255n) throw new Error(`Invalid ${field}`);
  return Number(parsed);
}

function parseItems(value: unknown, withRecipient: false): SeaportOfferItem[];
function parseItems(value: unknown, withRecipient: true): SeaportConsiderationItem[];
function parseItems(value: unknown, withRecipient: boolean): SeaportOfferItem[] | SeaportConsiderationItem[] {
  const field = withRecipient ? 'consideration' : 'offer';
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}`);
  return value.map((raw, i) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const parsed: SeaportOfferItem = {
      itemType: parseSmallInt(item.itemType, `${field}[${i}].itemType`),
      token: parseAddress(item.token, `${field}[${i}].token`),
      identifierOrCriteria: parseUint(item.identifierOrCriteria, `${field}[${i}].identifierOrCriteria`),
      startAmount: parseUint(item.startAmount, `${field}[${i}].startAmount`),
      endAmount: parseUint(item.endAmount, `${field}[${i}].endAmount`),
    };
    return withRecipient ? { ...parsed, recipient: parseAddress(item.recipient, `${field}[${i}].recipient`) } : parsed;
  }) as SeaportOfferItem[] | SeaportConsiderationItem[];
}

/** A missing counter aborts: guessing it would cancel or sign a different order than the one on the book. */
export function pickOrderComponents(orderData: Record<string, unknown> | null | undefined): OrderComponents {
  if (!orderData) throw new Error('Order has no order data');
  if (orderData.counter === undefined || orderData.counter === null || orderData.counter === '') {
    throw new Error('Order is missing its Seaport counter');
  }
  return {
    offerer: parseAddress(orderData.offerer, 'offerer'),
    zone: parseAddress(orderData.zone, 'zone'),
    offer: parseItems(orderData.offer, false),
    consideration: parseItems(orderData.consideration, true),
    orderType: parseSmallInt(orderData.orderType, 'orderType'),
    startTime: parseUint(orderData.startTime, 'startTime'),
    endTime: parseUint(orderData.endTime, 'endTime'),
    zoneHash: parseBytes32(orderData.zoneHash, 'zoneHash'),
    salt: parseUint(orderData.salt, 'salt'),
    conduitKey: parseBytes32(orderData.conduitKey, 'conduitKey'),
    counter: parseUint(orderData.counter, 'counter'),
  };
}

export function serializeOrderComponents(order: OrderComponents): SeaportOrderParameters {
  return {
    offerer: order.offerer.toLowerCase(),
    zone: order.zone.toLowerCase(),
    offer: order.offer.map(item => ({
      itemType: item.itemType,
      token: item.token.toLowerCase(),
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
    })),
    consideration: order.consideration.map(item => ({
      itemType: item.itemType,
      token: item.token.toLowerCase(),
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
      recipient: item.recipient.toLowerCase(),
    })),
    orderType: order.orderType,
    startTime: order.startTime.toString(),
    endTime: order.endTime.toString(),
    zoneHash: order.zoneHash.toLowerCase(),
    salt: order.salt.toString(),
    conduitKey: order.conduitKey.toLowerCase(),
    counter: order.counter.toString(),
    totalOriginalConsiderationItems: order.consideration.length,
  };
}

/** Rounds up so a royalty stays >= what is owed while every amount divides by the quantity. */
function ceilToMultiple(value: bigint, multiple: bigint): bigint {
  const remainder = value % multiple;
  return remainder === 0n ? value : value + (multiple - remainder);
}

export function computeSeaportAmounts(input: {
  unitPriceWei: bigint;
  quantity: bigint;
  feeBps: number;
  royaltyWei: bigint;
  royaltyRecipient: string | null | undefined;
  offerer: string;
}): SeaportSaleAmounts {
  const { unitPriceWei, quantity, feeBps, royaltyWei, offerer } = input;
  if (unitPriceWei <= 0n) throw new Error('Price must be greater than zero');
  if (quantity < 1n) throw new Error('Quantity must be at least 1');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('Invalid marketplace fee');
  if (royaltyWei < 0n) throw new Error('Invalid royalty');

  const total = unitPriceWei * quantity;
  const fee = ((unitPriceWei * BigInt(feeBps)) / 10000n) * quantity;

  const recipient = input.royaltyRecipient && ADDRESS_RE.test(input.royaltyRecipient) ? input.royaltyRecipient.toLowerCase() as Address : null;
  const royaltyApplies = royaltyWei > 0n
    && recipient !== null
    && recipient !== ZERO_ADDRESS
    && recipient !== offerer.toLowerCase();
  const royalty = royaltyApplies ? ceilToMultiple(royaltyWei, quantity) : 0n;

  const seller = total - fee - royalty;
  if (seller <= 0n) throw new Error('The fee and royalty exceed the listing price');

  return { total, fee, royalty, royaltyRecipient: royaltyApplies ? recipient : null, seller };
}

/** Fixed layout: seller, then fee (iff > 0), then royalty (iff > 0). */
export function buildSeaportConsideration(amounts: SeaportSaleAmounts, offerer: string, feeRecipient: string): SeaportConsiderationItem[] {
  const native = (amount: bigint, recipient: string): SeaportConsiderationItem => ({
    itemType: SEAPORT_ITEM_TYPE.NATIVE,
    token: ZERO_ADDRESS,
    identifierOrCriteria: 0n,
    startAmount: amount,
    endAmount: amount,
    recipient: recipient.toLowerCase() as Address,
  });

  const consideration = [native(amounts.seller, offerer)];
  if (amounts.fee > 0n) consideration.push(native(amounts.fee, feeRecipient));
  if (amounts.royalty > 0n && amounts.royaltyRecipient) consideration.push(native(amounts.royalty, amounts.royaltyRecipient));
  return consideration;
}

export function generateSeaportSalt(randomBytes: (length: number) => Uint8Array = length => new Uint8Array(nodeRandomBytes(length))): bigint {
  const bytes = randomBytes(28);
  if (bytes.length !== 28) throw new Error('Salt needs 28 random bytes');
  let salt = OSWIKI_SALT_MARKER;
  for (const byte of bytes) salt = (salt << 8n) | BigInt(byte);
  return salt;
}

export function isOswikiSalt(salt: bigint): boolean {
  return salt >> 224n === OSWIKI_SALT_MARKER;
}

export interface BuildListingOrderInput {
  offerer: string;
  token: string;
  tokenId: string | bigint;
  isErc1155: boolean;
  quantity?: number | bigint;
  unitPriceWei: bigint;
  feeBps: number;
  feeRecipient: string;
  royaltyRecipient?: string | null;
  royaltyWei?: bigint;
  counter: bigint;
  durationSeconds: number;
  nowSeconds?: number;
  salt?: bigint;
}

function assertDuration(durationSeconds: number, what: string): void {
  if (!Number.isInteger(durationSeconds)
    || durationSeconds < MIN_LISTING_DURATION_SECONDS
    || durationSeconds > MAX_LISTING_DURATION_SECONDS) {
    throw new Error(`${what} duration must be between 1 hour and 1 year`);
  }
}

export function buildListingOrder(input: BuildListingOrderInput): OrderComponents {
  if (!ADDRESS_RE.test(input.offerer)) throw new Error('Invalid seller address');
  if (!ADDRESS_RE.test(input.token)) throw new Error('Invalid collection address');
  if (!ADDRESS_RE.test(input.feeRecipient)) throw new Error('Invalid fee recipient');
  if (input.counter < 0n) throw new Error('Invalid Seaport counter');
  assertDuration(input.durationSeconds, 'Listing');

  const quantity = input.isErc1155 ? BigInt(input.quantity ?? 1) : 1n;
  if (quantity < 1n) throw new Error('Quantity must be at least 1');
  const tokenId = parseUint(typeof input.tokenId === 'bigint' ? input.tokenId : String(input.tokenId), 'tokenId');
  const offerer = input.offerer.toLowerCase() as Address;

  const amounts = computeSeaportAmounts({
    unitPriceWei: input.unitPriceWei,
    quantity,
    feeBps: input.feeBps,
    royaltyWei: input.royaltyWei ?? 0n,
    royaltyRecipient: input.royaltyRecipient,
    offerer,
  });

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const startTime = BigInt(now - LISTING_START_SKEW_SECONDS);

  return {
    offerer,
    zone: ZERO_ADDRESS,
    offer: [{
      itemType: input.isErc1155 ? SEAPORT_ITEM_TYPE.ERC1155 : SEAPORT_ITEM_TYPE.ERC721,
      token: input.token.toLowerCase() as Address,
      identifierOrCriteria: tokenId,
      startAmount: quantity,
      endAmount: quantity,
    }],
    consideration: buildSeaportConsideration(amounts, offerer, input.feeRecipient),
    orderType: input.isErc1155 ? SEAPORT_ORDER_TYPE.PARTIAL_OPEN : SEAPORT_ORDER_TYPE.FULL_OPEN,
    startTime,
    endTime: startTime + BigInt(input.durationSeconds),
    zoneHash: ZERO_BYTES32,
    salt: input.salt ?? generateSeaportSalt(),
    conduitKey: OPENSEA_CONDUIT_KEY,
    counter: input.counter,
  };
}

export type OfferKind = 'item' | 'collection';

export interface OfferAmounts {
  offerWei: bigint;
  feeWei: bigint;
  royaltyWei: bigint;
  royaltyRecipient: Address | null;
  sellerNetWei: bigint;
}

/** The royalty leg only exists when it is paid to someone other than the bidder and the fee recipient. */
export function computeOfferAmounts(input: {
  offerWei: bigint;
  feeWei: bigint;
  feeRecipient: string;
  royaltyWei: bigint;
  royaltyRecipient: string | null | undefined;
  offerer: string;
}): OfferAmounts {
  const { offerWei, feeWei, royaltyWei } = input;
  if (offerWei <= 0n) throw new Error('Offer must be greater than zero');
  if (feeWei < 0n) throw new Error('Invalid marketplace fee');
  if (royaltyWei < 0n) throw new Error('Invalid royalty');

  const recipient = input.royaltyRecipient && ADDRESS_RE.test(input.royaltyRecipient) ? input.royaltyRecipient.toLowerCase() as Address : null;
  const royaltyApplies = royaltyWei > 0n
    && recipient !== null
    && recipient !== ZERO_ADDRESS
    && recipient !== input.offerer.toLowerCase()
    && recipient !== input.feeRecipient.toLowerCase();
  const royalty = royaltyApplies ? royaltyWei : 0n;

  const sellerNetWei = offerWei - feeWei - royalty;
  if (sellerNetWei <= 0n) throw new Error('The fee and royalty exceed the offer');
  return { offerWei, feeWei, royaltyWei: royalty, royaltyRecipient: royaltyApplies ? recipient : null, sellerNetWei };
}

/** Fixed layout: the NFT to the bidder, then fee (iff > 0), then royalty (iff it applies), all in the offer currency. */
export function buildOfferConsideration(input: {
  kind: OfferKind;
  token: string;
  tokenId: string | bigint | null;
  isErc1155: boolean;
  offerer: string;
  currency: string;
  amounts: OfferAmounts;
  feeRecipient: string;
}): SeaportConsiderationItem[] {
  if (!ADDRESS_RE.test(input.token)) throw new Error('Invalid collection address');
  if (!ADDRESS_RE.test(input.currency)) throw new Error('Invalid offer currency');
  if (!ADDRESS_RE.test(input.feeRecipient)) throw new Error('Invalid fee recipient');
  const offerer = parseAddress(input.offerer, 'offerer');

  let nft: SeaportConsiderationItem;
  if (input.kind === 'collection') {
    if (input.isErc1155) throw new Error('Collection offers are ERC-721 only');
    nft = { itemType: SEAPORT_ITEM_TYPE.ERC721_WITH_CRITERIA, token: input.token.toLowerCase() as Address, identifierOrCriteria: 0n, startAmount: 1n, endAmount: 1n, recipient: offerer };
  } else {
    if (input.tokenId === null || input.tokenId === '') throw new Error('Item offers need a token id');
    const tokenId = parseUint(typeof input.tokenId === 'bigint' ? input.tokenId : String(input.tokenId), 'tokenId');
    nft = {
      itemType: input.isErc1155 ? SEAPORT_ITEM_TYPE.ERC1155 : SEAPORT_ITEM_TYPE.ERC721,
      token: input.token.toLowerCase() as Address,
      identifierOrCriteria: tokenId,
      startAmount: 1n,
      endAmount: 1n,
      recipient: offerer,
    };
  }

  const erc20 = (amount: bigint, recipient: string): SeaportConsiderationItem => ({
    itemType: SEAPORT_ITEM_TYPE.ERC20,
    token: input.currency.toLowerCase() as Address,
    identifierOrCriteria: 0n,
    startAmount: amount,
    endAmount: amount,
    recipient: recipient.toLowerCase() as Address,
  });

  const consideration = [nft];
  if (input.amounts.feeWei > 0n) consideration.push(erc20(input.amounts.feeWei, input.feeRecipient));
  if (input.amounts.royaltyWei > 0n && input.amounts.royaltyRecipient) consideration.push(erc20(input.amounts.royaltyWei, input.amounts.royaltyRecipient));
  return consideration;
}

export interface BuildOfferOrderInput {
  offerer: string;
  kind: OfferKind;
  token: string;
  tokenId: string | bigint | null;
  isErc1155: boolean;
  currency: string;
  amountWei: bigint;
  feeWei: bigint;
  feeRecipient: string;
  royaltyRecipient?: string | null;
  royaltyWei?: bigint;
  counter: bigint;
  durationSeconds: number;
  nowSeconds?: number;
  salt?: bigint;
}

/** Bidder order: one ERC-20 offer item, zone 0, conduitKey 0 (the allowance goes to Seaport itself), FULL_OPEN. */
export function buildOfferOrder(input: BuildOfferOrderInput): OrderComponents {
  if (!ADDRESS_RE.test(input.offerer)) throw new Error('Invalid bidder address');
  if (input.counter < 0n) throw new Error('Invalid Seaport counter');
  assertDuration(input.durationSeconds, 'Offer');
  const offerer = input.offerer.toLowerCase() as Address;
  const amounts = computeOfferAmounts({
    offerWei: input.amountWei,
    feeWei: input.feeWei,
    feeRecipient: input.feeRecipient,
    royaltyWei: input.royaltyWei ?? 0n,
    royaltyRecipient: input.royaltyRecipient,
    offerer,
  });

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const startTime = BigInt(now - LISTING_START_SKEW_SECONDS);

  return {
    offerer,
    zone: ZERO_ADDRESS,
    offer: [{
      itemType: SEAPORT_ITEM_TYPE.ERC20,
      token: input.currency.toLowerCase() as Address,
      identifierOrCriteria: 0n,
      startAmount: input.amountWei,
      endAmount: input.amountWei,
    }],
    consideration: buildOfferConsideration({
      kind: input.kind,
      token: input.token,
      tokenId: input.tokenId,
      isErc1155: input.isErc1155,
      offerer,
      currency: input.currency,
      amounts,
      feeRecipient: input.feeRecipient,
    }),
    orderType: SEAPORT_ORDER_TYPE.FULL_OPEN,
    startTime,
    endTime: startTime + BigInt(input.durationSeconds),
    zoneHash: ZERO_BYTES32,
    salt: input.salt ?? generateSeaportSalt(),
    conduitKey: ZERO_BYTES32,
    counter: input.counter,
  };
}

export interface SeaportOrderParametersStrict extends Omit<OrderComponents, 'counter'> {
  totalOriginalConsiderationItems: bigint;
}

/** Strict parse of an on-chain OrderParameters (no counter: Seaport reads the stored one). */
export function parseOrderParameters(raw: unknown): SeaportOrderParametersStrict {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid order parameters');
  const params = raw as Record<string, unknown>;
  return {
    offerer: parseAddress(params.offerer, 'offerer'),
    zone: parseAddress(params.zone, 'zone'),
    offer: parseItems(params.offer, false),
    consideration: parseItems(params.consideration, true),
    orderType: parseSmallInt(params.orderType, 'orderType'),
    startTime: parseUint(params.startTime, 'startTime'),
    endTime: parseUint(params.endTime, 'endTime'),
    zoneHash: parseBytes32(params.zoneHash, 'zoneHash'),
    salt: parseUint(params.salt, 'salt'),
    conduitKey: parseBytes32(params.conduitKey, 'conduitKey'),
    totalOriginalConsiderationItems: parseUint(params.totalOriginalConsiderationItems, 'totalOriginalConsiderationItems'),
  };
}

export const parseSeaportUint = parseUint;
export const parseSeaportAddress = parseAddress;
export const parseSeaportBytes32 = parseBytes32;
