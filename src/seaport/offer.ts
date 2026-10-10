import type { Address, Hex, PublicClient } from 'viem';

import {
  encodeBasicOrder,
  encodeMatchAdvancedOrders,
  WRAPPED_NATIVE_ABI,
  type BasicOrderParameters,
  type SeaportAdvancedOrder,
  type SeaportCriteriaResolver,
  type SeaportFulfillment,
} from '../abi.js';
import { getOswikiFeeRecipient, OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_ADDRESS, ZERO_BYTES32 } from '../constants.js';
import { orderHashFromAskId } from './fulfill.js';
import { MAX_ROYALTY_BPS, MAX_SEAPORT_FEE_BPS, readSeaportCounter, REQUIRED_FEE_BPS } from './listing.js';
import {
  computeOfferAmounts,
  parseOrderParameters,
  parseSeaportAddress,
  parseSeaportBytes32,
  parseSeaportUint,
  SEAPORT_ITEM_TYPE,
  type OfferKind,
  type SeaportConsiderationItem,
  type SeaportOrderParametersStrict,
} from './order.js';
import { hashOrderComponents } from './sign.js';

export const MAX_OFFERS_PER_REQUEST = 50;
export const BASIC_ERC721_TO_ERC20_FULL_OPEN = 16;
export const BASIC_ERC1155_TO_ERC20_FULL_OPEN = 20;

export class OfferRequirementsError extends Error {
  constructor(reason: string) {
    super(`The offer terms from the server did not pass a safety check (${reason}). Nothing was signed.`);
    this.name = 'OfferRequirementsError';
  }
}

export class OfferGuardError extends Error {
  constructor(reason: string) {
    super(`OSWiki offer rejected: ${reason}. Nothing was sent.`);
    this.name = 'OfferGuardError';
  }
}

export interface OfferRequirementsItem {
  contract: string;
  tokenId: string | null;
  kind: OfferKind;
  isErc1155: boolean;
  blocked: boolean;
  reason: string | null;
  feeWei: string;
  royaltyRecipient: string | null;
  royaltyWei: string;
  sellerNetWei: string;
}

export interface OfferRequirements {
  seaport: string;
  conduitKey: string;
  sellerConduitKey: string;
  currency: { address: string; symbol: string; decimals: number };
  feeRecipient: string;
  feeBps: number;
  balanceWei: string;
  allowanceWei: string;
  openOffersWei: string;
  requiredAllowanceWei: string;
  items: OfferRequirementsItem[];
}

const UINT_RE = /^(0|[1-9][0-9]*)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function uintString(value: unknown, field: string, fail: (reason: string) => never): bigint {
  if (typeof value !== 'string' || !UINT_RE.test(value)) fail(`invalid ${field}`);
  return BigInt(value as string);
}

export interface OfferItemRequest {
  kind: OfferKind;
  contract: string;
  tokenId: string | null;
  amountWei: bigint;
  quantity: number;
}

export function offerItemsTotal(items: OfferItemRequest[]): bigint {
  return items.reduce((sum, item) => sum + item.amountWei * BigInt(item.quantity), 0n);
}

export interface CheckedOfferRequirements {
  currency: Address;
  feeRecipient: Address;
  openOffersWei: bigint;
  requiredAllowanceWei: bigint;
  items: Array<OfferRequirementsItem & { feeWeiBig: bigint; royaltyWeiBig: bigint; sellerNetWeiBig: bigint }>;
}

/** Seaport, the conduit keys, the currency and the fee recipient must be our constants; every amount must add up. */
export function assertOfferRequirements(
  requirements: OfferRequirements,
  input: { chainId: number; maker: string; items: OfferItemRequest[] },
): CheckedOfferRequirements {
  const fail = (reason: string): never => {
    throw new OfferRequirementsError(reason);
  };
  const currency = WRAPPED_NATIVE[input.chainId] ?? fail('unsupported chain');
  const feeRecipient = getOswikiFeeRecipient(input.chainId).toLowerCase() as Address;

  if (!requirements || typeof requirements !== 'object') fail('missing requirements');
  if (requirements.seaport?.toLowerCase() !== SEAPORT_ADDRESS) fail('unexpected Seaport address');
  if (requirements.conduitKey?.toLowerCase() !== ZERO_BYTES32) fail('unexpected offer conduit key');
  if (requirements.sellerConduitKey?.toLowerCase() !== OPENSEA_CONDUIT_KEY) fail('unexpected seller conduit key');
  if (requirements.currency?.address?.toLowerCase() !== currency || requirements.currency.decimals !== 18) fail('unexpected currency');
  if (requirements.feeRecipient?.toLowerCase() !== feeRecipient) fail('unexpected fee recipient');
  if (requirements.feeBps !== REQUIRED_FEE_BPS) fail('unexpected fee');
  if (!Array.isArray(requirements.items) || requirements.items.length !== input.items.length) fail('item count mismatch');
  if (requirements.items.some(item => item?.blocked === true)) fail('this collection only trades through OpenSea\'s own zone');

  const openOffersWei = uintString(requirements.openOffersWei, 'open offers', fail);
  const requiredAllowanceWei = uintString(requirements.requiredAllowanceWei, 'required allowance', fail);
  if (requiredAllowanceWei !== openOffersWei + offerItemsTotal(input.items)) fail('required allowance mismatch');

  const items = input.items.map((request, i) => {
    const item = requirements.items[i]!;
    if (item.contract?.toLowerCase() !== request.contract.toLowerCase() || item.kind !== request.kind) fail('item mismatch');
    if (request.kind === 'item' ? String(item.tokenId) !== String(request.tokenId) : item.tokenId !== null) fail('item mismatch');
    if (request.kind === 'collection' && item.isErc1155) fail('collection offers are ERC-721 only');
    if (item.royaltyRecipient !== null && !ADDRESS_RE.test(item.royaltyRecipient ?? '')) fail('invalid royalty recipient');

    const feeWeiBig = uintString(item.feeWei, 'fee', fail);
    const royaltyWeiBig = uintString(item.royaltyWei, 'royalty', fail);
    const sellerNetWeiBig = uintString(item.sellerNetWei, 'seller net', fail);
    if (feeWeiBig !== (request.amountWei * BigInt(requirements.feeBps)) / 10000n) fail('fee mismatch');
    if (royaltyWeiBig * 10000n > request.amountWei * BigInt(MAX_ROYALTY_BPS)) fail('royalty too high');

    let amounts;
    try {
      amounts = computeOfferAmounts({ offerWei: request.amountWei, feeWei: feeWeiBig, feeRecipient, royaltyWei: royaltyWeiBig, royaltyRecipient: item.royaltyRecipient, offerer: input.maker });
    } catch {
      return fail('fee and royalty exceed the offer');
    }
    if (amounts.sellerNetWei !== sellerNetWeiBig) fail('seller net mismatch');
    return { ...item, feeWeiBig, royaltyWeiBig: amounts.royaltyWei, sellerNetWeiBig };
  });

  return { currency, feeRecipient, openOffersWei, requiredAllowanceWei, items };
}

export interface OfferFunding {
  wrappedBalance: bigint;
  nativeBalance: bigint;
  allowance: bigint;
  counter: bigint;
}

/** Balances and allowance as Seaport will see them; the counter read is mandatory (never 0 by default). */
export async function readOfferFunding(client: PublicClient, chainId: number, maker: Address): Promise<OfferFunding> {
  const currency = WRAPPED_NATIVE[chainId];
  if (!currency) throw new Error('Offers are not supported on this chain');
  const [wrappedBalance, nativeBalance, allowance, counter] = await Promise.all([
    client.readContract({ address: currency, abi: WRAPPED_NATIVE_ABI, functionName: 'balanceOf', args: [maker] }),
    client.getBalance({ address: maker }),
    client.readContract({ address: currency, abi: WRAPPED_NATIVE_ABI, functionName: 'allowance', args: [maker, SEAPORT_ADDRESS] }),
    readSeaportCounter(client, maker),
  ]);
  return { wrappedBalance, nativeBalance, allowance, counter };
}

export interface AcceptOfferData {
  bidId?: unknown;
  kind?: unknown;
  to?: unknown;
  value?: unknown;
  method?: unknown;
  amounts?: { offerWei?: unknown; feeWei?: unknown; royaltyWei?: unknown; sellerNetWei?: unknown } | null;
  currency?: unknown;
  approval?: { token?: unknown; operator?: unknown } | null;
  basicOrderParameters?: Record<string, unknown> | null;
  orders?: unknown;
  criteriaResolvers?: unknown;
  fulfillments?: unknown;
  recipient?: unknown;
}

export interface OfferAcceptExpectation {
  chainId: number;
  bidId: string;
  maker: string;
  fulfiller: string;
  contract: string;
  tokenId: string;
  kind?: OfferKind;
  /** Bidder's live Seaport counter: the rebuilt struct hash must equal the bidId. */
  counter: bigint;
  nowSeconds?: number;
}

export interface GuardedOfferAmounts {
  offerWei: bigint;
  feeWei: bigint;
  royaltyWei: bigint;
  sellerNetWei: bigint;
}

interface GuardedBase {
  bidId: string;
  bidOrder: SeaportOrderParametersStrict;
  amounts: GuardedOfferAmounts;
  currency: Address;
  contract: Address;
  tokenId: bigint;
}

export interface GuardedItemAccept extends GuardedBase {
  kind: 'item';
  basicOrderParameters: BasicOrderParameters;
}

export interface GuardedCollectionAccept extends GuardedBase {
  kind: 'collection';
  orders: SeaportAdvancedOrder[];
  criteriaResolvers: SeaportCriteriaResolver[];
  fulfillments: SeaportFulfillment[];
  recipient: Address;
}

export type GuardedOfferAccept = GuardedItemAccept | GuardedCollectionAccept;

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function smallInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && UINT_RE.test(value)) return Number(value);
  return null;
}

function bidOrderFromBasic(params: Record<string, unknown>, fail: (reason: string) => never): SeaportOrderParametersStrict {
  const basicOrderType = smallInt(params.basicOrderType);
  const nftType = basicOrderType === BASIC_ERC721_TO_ERC20_FULL_OPEN
    ? SEAPORT_ITEM_TYPE.ERC721
    : basicOrderType === BASIC_ERC1155_TO_ERC20_FULL_OPEN ? SEAPORT_ITEM_TYPE.ERC1155 : fail('basicOrderType must be 16 or 20');
  if (!Array.isArray(params.additionalRecipients)) fail('missing additional recipients');
  try {
    const offerer = parseSeaportAddress(params.offerer, 'offerer');
    const offerToken = parseSeaportAddress(params.offerToken, 'offerToken');
    const offerAmount = parseSeaportUint(params.offerAmount, 'offerAmount');
    const legs: SeaportConsiderationItem[] = (params.additionalRecipients as Array<Record<string, unknown>>).map((leg, i) => {
      const amount = parseSeaportUint(leg?.amount, `additionalRecipients[${i}].amount`);
      return { itemType: SEAPORT_ITEM_TYPE.ERC20, token: offerToken, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount, recipient: parseSeaportAddress(leg?.recipient, `additionalRecipients[${i}].recipient`) };
    });
    const considerationAmount = parseSeaportUint(params.considerationAmount, 'considerationAmount');
    return {
      offerer,
      zone: parseSeaportAddress(params.zone, 'zone'),
      offer: [{ itemType: SEAPORT_ITEM_TYPE.ERC20, token: offerToken, identifierOrCriteria: parseSeaportUint(params.offerIdentifier, 'offerIdentifier'), startAmount: offerAmount, endAmount: offerAmount }],
      consideration: [
        { itemType: nftType, token: parseSeaportAddress(params.considerationToken, 'considerationToken'), identifierOrCriteria: parseSeaportUint(params.considerationIdentifier, 'considerationIdentifier'), startAmount: considerationAmount, endAmount: considerationAmount, recipient: offerer },
        ...legs,
      ],
      orderType: (basicOrderType as number) % 4,
      startTime: parseSeaportUint(params.startTime, 'startTime'),
      endTime: parseSeaportUint(params.endTime, 'endTime'),
      zoneHash: parseSeaportBytes32(params.zoneHash, 'zoneHash'),
      salt: parseSeaportUint(params.salt, 'salt'),
      conduitKey: parseSeaportBytes32(params.offererConduitKey, 'offererConduitKey'),
      totalOriginalConsiderationItems: parseSeaportUint(params.totalOriginalAdditionalRecipients, 'totalOriginalAdditionalRecipients') + 1n,
    };
  } catch (err) {
    return fail((err as Error).message);
  }
}

function assertBidOrder(
  order: SeaportOrderParametersStrict,
  ctx: { kind: OfferKind; maker: string; contract: Address; tokenId: bigint; currency: Address; feeRecipient: string; amounts: GuardedOfferAmounts },
  fail: (reason: string) => never,
): void {
  if (order.offerer !== ctx.maker.toLowerCase()) fail('offerer is not the bid maker');
  if (order.zone !== ZERO_ADDRESS || order.zoneHash !== ZERO_BYTES32) fail('zone must be 0');
  if (order.conduitKey !== ZERO_BYTES32) fail('offer conduitKey must be 0');
  if (order.orderType !== 0) fail('orderType must be FULL_OPEN');

  if (order.offer.length !== 1) fail('exactly one offer item required');
  const offer = order.offer[0]!;
  if (offer.itemType !== SEAPORT_ITEM_TYPE.ERC20 || offer.token !== ctx.currency || offer.identifierOrCriteria !== 0n) fail('offer must be the wrapped native token');
  if (offer.startAmount !== offer.endAmount || offer.startAmount !== ctx.amounts.offerWei) fail('offer amount mismatch');

  const nft = order.consideration[0] ?? fail('empty consideration');
  if (nft.token !== ctx.contract) fail('consideration is not this collection');
  if (nft.startAmount !== 1n || nft.endAmount !== 1n) fail('NFT amount must be 1');
  if (nft.recipient !== order.offerer) fail('NFT must go to the bidder');
  if (ctx.kind === 'item') {
    if (nft.itemType !== SEAPORT_ITEM_TYPE.ERC721 && nft.itemType !== SEAPORT_ITEM_TYPE.ERC1155) fail('item offer must name an ERC-721 or ERC-1155');
    if (nft.identifierOrCriteria !== ctx.tokenId) fail('offer is for another token');
  } else if (nft.itemType !== SEAPORT_ITEM_TYPE.ERC721_WITH_CRITERIA || nft.identifierOrCriteria !== 0n) {
    fail('collection offer must use criteria 0');
  }

  const legs = order.consideration.slice(1);
  if (legs.length > 2) fail('too many payment legs');
  let fee = 0n;
  let royalty = 0n;
  legs.forEach((leg, i) => {
    if (leg.itemType !== SEAPORT_ITEM_TYPE.ERC20 || leg.token !== ctx.currency || leg.identifierOrCriteria !== 0n) fail('payment legs must be the offer currency');
    if (leg.startAmount <= 0n || leg.startAmount !== leg.endAmount) fail('payment legs must be fixed');
    if (leg.recipient === ctx.feeRecipient.toLowerCase()) {
      if (i !== 0 || fee > 0n) fail('fee leg out of place');
      fee = leg.startAmount;
    } else {
      if (royalty > 0n || leg.recipient === ZERO_ADDRESS || leg.recipient === order.offerer) fail('unexpected payment recipient');
      royalty = leg.startAmount;
    }
  });
  if (order.totalOriginalConsiderationItems !== BigInt(order.consideration.length)) fail('totalOriginalConsiderationItems mismatch');
  if (fee !== ctx.amounts.feeWei || royalty !== ctx.amounts.royaltyWei) fail('fee or royalty does not match the quote');
  if (fee * 10000n > ctx.amounts.offerWei * BigInt(MAX_SEAPORT_FEE_BPS)) fail('fee too high');
  if (royalty * 10000n > ctx.amounts.offerWei * BigInt(MAX_ROYALTY_BPS)) fail('royalty too high');
  if (ctx.amounts.offerWei - fee - royalty !== ctx.amounts.sellerNetWei || ctx.amounts.sellerNetWei <= 0n) fail('seller net does not add up');
}

function readAmounts(data: AcceptOfferData, fail: (reason: string) => never): GuardedOfferAmounts {
  const raw = data.amounts ?? fail('missing amounts');
  return {
    offerWei: uintString(raw.offerWei, 'offerWei', fail),
    feeWei: uintString(raw.feeWei, 'feeWei', fail),
    royaltyWei: uintString(raw.royaltyWei, 'royaltyWei', fail),
    sellerNetWei: uintString(raw.sellerNetWei, 'sellerNetWei', fail),
  };
}

function sameFulfillments(actual: unknown, expected: Array<[[number, number], [number, number]]>): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every(([offer, consideration], i) => {
    const entry = actual[i] as { offerComponents?: unknown; considerationComponents?: unknown } | undefined;
    const one = (components: unknown, [orderIndex, itemIndex]: [number, number]) => Array.isArray(components)
      && components.length === 1
      && smallInt((components[0] as { orderIndex?: unknown })?.orderIndex) === orderIndex
      && smallInt((components[0] as { itemIndex?: unknown })?.itemIndex) === itemIndex;
    return !!entry && one(entry.offerComponents, offer) && one(entry.considerationComponents, consideration);
  });
}

function basicParametersFrom(order: SeaportOrderParametersStrict, signature: Hex): BasicOrderParameters {
  const nft = order.consideration[0]!;
  const offer = order.offer[0]!;
  return {
    considerationToken: nft.token,
    considerationIdentifier: nft.identifierOrCriteria,
    considerationAmount: nft.startAmount,
    offerer: order.offerer,
    zone: order.zone,
    offerToken: offer.token,
    offerIdentifier: offer.identifierOrCriteria,
    offerAmount: offer.startAmount,
    basicOrderType: nft.itemType === SEAPORT_ITEM_TYPE.ERC1155 ? BASIC_ERC1155_TO_ERC20_FULL_OPEN : BASIC_ERC721_TO_ERC20_FULL_OPEN,
    startTime: order.startTime,
    endTime: order.endTime,
    zoneHash: order.zoneHash,
    salt: order.salt,
    offererConduitKey: order.conduitKey,
    fulfillerConduitKey: OPENSEA_CONDUIT_KEY,
    totalOriginalAdditionalRecipients: BigInt(order.consideration.length - 1),
    additionalRecipients: order.consideration.slice(1).map(leg => ({ amount: leg.startAmount, recipient: leg.recipient })),
    signature,
  };
}

function addressOr(value: string, fail: (reason: string) => never): Address {
  try {
    return parseSeaportAddress(value, 'address');
  } catch {
    return fail('invalid address');
  }
}

/**
 * Accept-side check: the bid, the seller's mirror order, resolvers and fulfillments must be
 * exactly the contract layout, and the bid must hash to its id under the live counter.
 */
export function assertOswikiSeaportOffer(data: AcceptOfferData, expected: OfferAcceptExpectation): GuardedOfferAccept {
  const fail = (reason: string): never => {
    throw new OfferGuardError(reason);
  };
  if (!data || typeof data !== 'object') fail('missing accept data');
  const currency = WRAPPED_NATIVE[expected.chainId] ?? fail('unsupported chain');
  const feeRecipient = getOswikiFeeRecipient(expected.chainId).toLowerCase();
  const fulfiller = addressOr(expected.fulfiller, fail);
  const contract = addressOr(expected.contract, fail);
  const tokenId = UINT_RE.test(expected.tokenId) ? BigInt(expected.tokenId) : fail('invalid token id');

  if (data.bidId !== expected.bidId) fail('accept data is for another offer');
  if (!sameAddress(data.to, SEAPORT_ADDRESS)) fail('target is not Seaport 1.6');
  if (String(data.value) !== '0') fail('value must be 0');
  if (expected.kind && data.kind !== expected.kind) fail('offer kind mismatch');
  if (!sameAddress(data.approval?.token, contract) || !sameAddress(data.approval?.operator, OPENSEA_CONDUIT_ADDRESS)) fail('unexpected approval target');
  const currencyAddress = typeof data.currency === 'string' ? data.currency : (data.currency as { address?: unknown } | null | undefined)?.address;
  if (currencyAddress !== undefined && !sameAddress(currencyAddress, currency)) fail('unexpected currency');
  const amounts = readAmounts(data, fail);

  let guarded: GuardedOfferAccept;
  if (data.kind === 'item') {
    if (data.method !== 'fulfillBasicOrder_efficient_6GL6yc') fail('item offers fill through the basic route');
    const params = data.basicOrderParameters ?? fail('missing basic order parameters');
    const bidOrder = bidOrderFromBasic(params, fail);
    assertBidOrder(bidOrder, { kind: 'item', maker: expected.maker, contract, tokenId, currency, feeRecipient, amounts }, fail);
    if (!sameAddress(params.fulfillerConduitKey, OPENSEA_CONDUIT_KEY)) fail('fulfillerConduitKey must be the OpenSea key');
    if (smallInt(params.totalOriginalAdditionalRecipients) !== bidOrder.consideration.length - 1) fail('totalOriginalAdditionalRecipients mismatch');
    if (typeof params.signature !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(params.signature)) fail('missing signature');
    guarded = { kind: 'item', bidId: expected.bidId, bidOrder, amounts, currency, contract, tokenId, basicOrderParameters: basicParametersFrom(bidOrder, params.signature as Hex) };
  } else if (data.kind === 'collection') {
    if (data.method !== 'matchAdvancedOrders') fail('collection offers fill through matchAdvancedOrders');
    if (!Array.isArray(data.orders) || data.orders.length !== 2) fail('exactly two orders required');
    type RawAdvanced = { parameters: unknown; numerator: unknown; denominator: unknown; signature: unknown; extraData: unknown };
    const [bidAdvanced, mirrorAdvanced] = data.orders as [RawAdvanced, RawAdvanced];
    let bidOrder: SeaportOrderParametersStrict;
    let mirrorOrder: SeaportOrderParametersStrict;
    try {
      bidOrder = parseOrderParameters(bidAdvanced?.parameters);
      mirrorOrder = parseOrderParameters(mirrorAdvanced?.parameters);
    } catch (err) {
      return fail((err as Error).message);
    }
    assertBidOrder(bidOrder, { kind: 'collection', maker: expected.maker, contract, tokenId, currency, feeRecipient, amounts }, fail);
    for (const order of [bidAdvanced, mirrorAdvanced]) {
      if (smallInt(order.numerator) !== 1 || smallInt(order.denominator) !== 1) fail('orders must fill whole');
      if (order.extraData !== '0x') fail('zone-0 orders carry no extraData');
    }
    if (typeof bidAdvanced.signature !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(bidAdvanced.signature)) fail('missing bid signature');

    if (mirrorOrder.offerer !== fulfiller) fail('mirror offerer is not you');
    if (mirrorOrder.zone !== ZERO_ADDRESS || mirrorOrder.zoneHash !== ZERO_BYTES32 || mirrorOrder.orderType !== 0) fail('mirror must be zone 0, FULL_OPEN');
    if (mirrorOrder.conduitKey !== OPENSEA_CONDUIT_KEY) fail('mirror conduitKey must be the OpenSea key');
    if (mirrorAdvanced.signature !== '0x') fail('mirror must be unsigned');
    const mirrorOffer = mirrorOrder.offer;
    if (mirrorOffer.length !== 1
      || mirrorOffer[0]!.itemType !== SEAPORT_ITEM_TYPE.ERC721
      || mirrorOffer[0]!.token !== contract
      || mirrorOffer[0]!.identifierOrCriteria !== tokenId
      || mirrorOffer[0]!.startAmount !== 1n
      || mirrorOffer[0]!.endAmount !== 1n) fail('mirror must offer exactly this NFT');
    const mirrorConsideration = mirrorOrder.consideration;
    if (mirrorConsideration.length !== 1
      || mirrorConsideration[0]!.itemType !== SEAPORT_ITEM_TYPE.ERC20
      || mirrorConsideration[0]!.token !== currency
      || mirrorConsideration[0]!.identifierOrCriteria !== 0n
      || mirrorConsideration[0]!.startAmount !== amounts.sellerNetWei
      || mirrorConsideration[0]!.endAmount !== amounts.sellerNetWei
      || mirrorConsideration[0]!.recipient !== fulfiller) fail('mirror must ask exactly the seller net');
    if (mirrorOrder.totalOriginalConsiderationItems !== 1n) fail('mirror totalOriginalConsiderationItems mismatch');
    const now = BigInt(expected.nowSeconds ?? Math.floor(Date.now() / 1000));
    if (mirrorOrder.endTime <= now || mirrorOrder.startTime > now + 300n) fail('mirror is outside its time window');

    const resolvers = data.criteriaResolvers;
    if (!Array.isArray(resolvers) || resolvers.length !== 1) fail('exactly one criteria resolver required');
    const resolver = (resolvers as Array<Record<string, unknown>>)[0]!;
    if (smallInt(resolver.orderIndex) !== 0 || smallInt(resolver.side) !== 1 || smallInt(resolver.index) !== 0
      || String(resolver.identifier) !== tokenId.toString()
      || !Array.isArray(resolver.criteriaProof) || resolver.criteriaProof.length !== 0) fail('unexpected criteria resolver');

    const layout: Array<[[number, number], [number, number]]> = [[[1, 0], [0, 0]], [[0, 0], [1, 0]]];
    for (let j = 1; j < bidOrder.consideration.length; j++) layout.push([[0, 0], [0, j]]);
    if (!sameFulfillments(data.fulfillments, layout)) fail('unexpected fulfillments');
    if (!sameAddress(data.recipient, fulfiller)) fail('recipient must be you');

    const component = (orderIndex: number, itemIndex: number) => ({ orderIndex: BigInt(orderIndex), itemIndex: BigInt(itemIndex) });
    guarded = {
      kind: 'collection',
      bidId: expected.bidId,
      bidOrder,
      amounts,
      currency,
      contract,
      tokenId,
      orders: [
        { parameters: bidOrder, numerator: 1n, denominator: 1n, signature: bidAdvanced.signature as Hex, extraData: '0x' },
        { parameters: mirrorOrder, numerator: 1n, denominator: 1n, signature: '0x', extraData: '0x' },
      ],
      criteriaResolvers: [{ orderIndex: 0n, side: 1, index: 0n, identifier: tokenId, criteriaProof: [] }],
      fulfillments: layout.map(([offer, consideration]) => ({ offerComponents: [component(...offer)], considerationComponents: [component(...consideration)] })),
      recipient: fulfiller,
    };
  } else {
    return fail('unknown offer kind');
  }

  const { totalOriginalConsiderationItems: _total, ...components } = guarded.bidOrder;
  if (orderHashFromAskId(expected.bidId) !== hashOrderComponents({ ...components, counter: expected.counter })) fail('order does not hash to this offer');
  return guarded;
}

/** Local calldata for a guarded accept (OSWiki domain tag appended); backend calldata is never sent. */
export function encodeOfferAccept(guarded: GuardedOfferAccept): Hex {
  if (guarded.kind === 'item') return encodeBasicOrder(guarded.basicOrderParameters);
  return encodeMatchAdvancedOrders(guarded.orders, guarded.criteriaResolvers, guarded.fulfillments, guarded.recipient);
}
