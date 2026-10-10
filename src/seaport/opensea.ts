import { randomBytes as nodeRandomBytes } from 'node:crypto';

import type { Address, Hex } from 'viem';

import { APECHAIN_ID, MAINNET_ID, OPENSEA_CONDUIT_KEY, OPENSEA_FEE_RECIPIENT, SEAPORT_ADDRESS, ZERO_ADDRESS, ZERO_BYTES32 } from '../constants.js';
import type { OpenSeaListingTerms } from './listing.js';
import { pickOrderComponents, SEAPORT_ITEM_TYPE, type OrderComponents, type SeaportConsiderationItem } from './order.js';
import { hashOrderComponents } from './sign.js';

export const OPENSEA_ORDER_TYPE = { PARTIAL_OPEN: 1, PARTIAL_RESTRICTED: 3 } as const;
export const MAX_OPENSEA_TOTAL_FEE_BPS = 3500;
export const MAX_OPENSEA_FEE_BPS = 100;
export const OPENSEA_SIGNED_ZONE = '0x000056f7000000ece9003ca63978907a00ffd100' as const;
export const OPENSEA_ZONES: ReadonlySet<string> = new Set([ZERO_ADDRESS, OPENSEA_SIGNED_ZONE]);
export const CREATOR_FEE_TOLERANCE_BPS = 1;
const OPENSEA_CHAIN_NAMES: Record<number, string> = { [MAINNET_ID]: 'ethereum', [APECHAIN_ID]: 'ape_chain' };
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BPS_DENOMINATOR = 10000n;

export function applyOpenSeaMarkup(unitPriceWei: bigint, markupBps: number): bigint {
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > 10000) throw new Error('Invalid OpenSea markup');
  return (unitPriceWei * BigInt(10000 + markupBps)) / BPS_DENOMINATOR;
}

export interface OpenSeaFee {
  recipient: Address;
  bps: number;
}

export interface UsableOpenSeaTerms {
  chain: string;
  zone: Address;
  orderType: number;
  feeRecipient: Address;
  feeBps: number;
  creatorFees: OpenSeaFee[];
}

/** The OSWiki order's royalty leg after verification: the only creator fee a twin may pay. */
export interface TwinRoyalty {
  recipient: Address | null;
  wei: bigint;
  totalWei: bigint;
}

export class OpenSeaTwinError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'OpenSeaTwinError';
  }
}

function isBps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10000;
}

/** Protocol, conduit, fee recipient, fee cap and zone must be our constants, never the server's say-so. */
export function usableOpenSeaTerms(terms: OpenSeaListingTerms | null | undefined, chainId: number): UsableOpenSeaTerms | null {
  if (!terms || typeof terms !== 'object') return null;
  const chain = OPENSEA_CHAIN_NAMES[chainId];
  if (!chain || terms.chain !== chain) return null;
  if (typeof terms.protocolAddress !== 'string' || terms.protocolAddress.toLowerCase() !== SEAPORT_ADDRESS) return null;
  if (typeof terms.conduitKey !== 'string' || terms.conduitKey.toLowerCase() !== OPENSEA_CONDUIT_KEY) return null;
  if (typeof terms.feeRecipient !== 'string' || terms.feeRecipient.toLowerCase() !== OPENSEA_FEE_RECIPIENT) return null;
  if (typeof terms.zone !== 'string' || !ADDRESS_RE.test(terms.zone)) return null;
  const zone = terms.zone.toLowerCase() as Address;
  if (!OPENSEA_ZONES.has(zone)) return null;
  if (terms.orderType !== (zone === ZERO_ADDRESS ? OPENSEA_ORDER_TYPE.PARTIAL_OPEN : OPENSEA_ORDER_TYPE.PARTIAL_RESTRICTED)) return null;
  if (!isBps(terms.feeBps) || terms.feeBps > MAX_OPENSEA_FEE_BPS || !Array.isArray(terms.creatorFees)) return null;

  const creatorFees: OpenSeaFee[] = [];
  for (const fee of terms.creatorFees) {
    if (!fee || typeof fee.recipient !== 'string' || !ADDRESS_RE.test(fee.recipient) || !isBps(fee.bps)) return null;
    const recipient = fee.recipient.toLowerCase() as Address;
    if (recipient === ZERO_ADDRESS || recipient === OPENSEA_FEE_RECIPIENT) return null;
    creatorFees.push({ recipient, bps: fee.bps });
  }
  const totalBps = creatorFees.reduce((sum, fee) => sum + fee.bps, terms.feeBps);
  if (totalBps > MAX_OPENSEA_TOTAL_FEE_BPS) return null;

  return { chain, zone, orderType: terms.orderType, feeRecipient: OPENSEA_FEE_RECIPIENT, feeBps: terms.feeBps, creatorFees };
}

/** Creator fees may only pay the verified royalty recipient, at most its OSWiki share plus 1 bps. */
export function assertTwinCreatorFees(terms: UsableOpenSeaTerms, royalty: TwinRoyalty, offerer: string): void {
  const self = offerer.toLowerCase();
  let creatorBps = 0;
  for (const fee of terms.creatorFees) {
    if (fee.recipient === self || fee.bps === 0) continue;
    if (royalty.recipient === null || fee.recipient !== royalty.recipient) {
      throw new OpenSeaTwinError(`OpenSea asks for a creator fee to ${fee.recipient}, which is not the collection's verified royalty recipient${royalty.recipient ? ` ${royalty.recipient}` : ' (this listing pays no royalty)'}`);
    }
    creatorBps += fee.bps;
  }
  if (creatorBps > 0 && BigInt(creatorBps) * royalty.totalWei > royalty.wei * BPS_DENOMINATOR + BigInt(CREATOR_FEE_TOLERANCE_BPS) * royalty.totalWei) {
    throw new OpenSeaTwinError(`OpenSea asks for a ${creatorBps / 100}% creator fee, more than the royalty this listing pays on OSWiki`);
  }
}

function unitFees(unitPriceWei: bigint, terms: UsableOpenSeaTerms, offerer: string): Array<{ recipient: Address; amount: bigint }> {
  const perUnit = (bps: number) => (unitPriceWei * BigInt(bps) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  const fees: Array<{ recipient: Address; amount: bigint }> = [];
  if (terms.feeBps > 0) fees.push({ recipient: terms.feeRecipient, amount: perUnit(terms.feeBps) });
  for (const fee of terms.creatorFees) {
    if (fee.bps > 0 && fee.recipient !== offerer) fees.push({ recipient: fee.recipient, amount: perUnit(fee.bps) });
  }
  return fees;
}

/** Fees round up per unit then scale, so each stays >= floor(total * bps / 10000) and divides by the quantity. */
export function computeOpenSeaAmounts(input: { unitPriceWei: bigint; quantity: bigint; terms: UsableOpenSeaTerms; offerer: string }) {
  const { unitPriceWei, quantity, terms } = input;
  if (unitPriceWei <= 0n) throw new Error('Price must be greater than zero');
  if (quantity < 1n) throw new Error('Quantity must be at least 1');
  const fees = unitFees(unitPriceWei, terms, input.offerer.toLowerCase());
  const sellerUnit = fees.reduce((rest, fee) => rest - fee.amount, unitPriceWei);
  if (sellerUnit <= 0n) throw new Error('OpenSea fees exceed the listing price');

  return {
    total: unitPriceWei * quantity,
    fees: fees.map(fee => ({ recipient: fee.recipient, amount: fee.amount * quantity })),
    seller: sellerUnit * quantity,
  };
}

/** Lowest unit price >= `startUnitWei` whose OpenSea payout is at least `sellerUnitWei`. */
export function minimumOpenSeaUnitPrice(startUnitWei: bigint, sellerUnitWei: bigint, terms: UsableOpenSeaTerms, offerer: string): bigint {
  const self = offerer.toLowerCase();
  const bps = BigInt(terms.feeBps + terms.creatorFees.filter(fee => fee.recipient !== self).reduce((sum, fee) => sum + fee.bps, 0));
  if (bps >= BPS_DENOMINATOR) throw new Error('OpenSea fees exceed the listing price');
  let price = startUnitWei;
  for (let i = 0; i < 64; i++) {
    const net = unitFees(price, terms, self).reduce((rest, fee) => rest - fee.amount, price);
    if (net >= sellerUnitWei) return price;
    price += ((sellerUnitWei - net) * BPS_DENOMINATOR + (BPS_DENOMINATOR - bps) - 1n) / (BPS_DENOMINATOR - bps);
  }
  throw new Error('Could not price the OpenSea listing');
}

export function generateOpenSeaSalt(randomBytes: (length: number) => Uint8Array = length => new Uint8Array(nodeRandomBytes(length))): bigint {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new Error('Salt needs 32 random bytes');
  let salt = 0n;
  for (const byte of bytes) salt = (salt << 8n) | BigInt(byte);
  return salt;
}

function sellerLeg(order: OrderComponents): bigint {
  const first = order.consideration[0];
  return first && first.recipient === order.offerer.toLowerCase() ? first.startAmount : 0n;
}

/**
 * The OpenSea twin: same offer, times and counter as the OSWiki order, priced at the markup and
 * never below what pays the seller at least the OSWiki payout.
 */
export function buildOpenSeaOrder(oswiki: OrderComponents, terms: UsableOpenSeaTerms, salt?: bigint, markupBps = 0): OrderComponents {
  if (oswiki.conduitKey.toLowerCase() !== OPENSEA_CONDUIT_KEY) throw new Error('Unexpected conduit key');
  if (oswiki.offer.length !== 1) throw new Error('Expected exactly one offer item');
  const quantity = oswiki.offer[0]!.startAmount;
  const total = oswiki.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
  if (quantity < 1n || total % quantity !== 0n) throw new Error('Listing total does not divide by its quantity');

  const offerer = oswiki.offerer.toLowerCase() as Address;
  const sellerUnit = (sellerLeg(oswiki) + quantity - 1n) / quantity;
  const unitPrice = minimumOpenSeaUnitPrice(applyOpenSeaMarkup(total / quantity, markupBps), sellerUnit, terms, offerer);
  const amounts = computeOpenSeaAmounts({ unitPriceWei: unitPrice, quantity, terms, offerer });
  const native = (amount: bigint, recipient: Address): SeaportConsiderationItem => ({
    itemType: SEAPORT_ITEM_TYPE.NATIVE,
    token: ZERO_ADDRESS,
    identifierOrCriteria: 0n,
    startAmount: amount,
    endAmount: amount,
    recipient,
  });

  return {
    offerer,
    zone: terms.zone,
    offer: oswiki.offer.map(item => ({ ...item })),
    consideration: [native(amounts.seller, offerer), ...amounts.fees.map(fee => native(fee.amount, fee.recipient))],
    orderType: terms.orderType,
    startTime: oswiki.startTime,
    endTime: oswiki.endTime,
    zoneHash: ZERO_BYTES32,
    salt: salt ?? generateOpenSeaSalt(),
    conduitKey: oswiki.conduitKey,
    counter: oswiki.counter,
  };
}

export interface TwinSummary {
  total: bigint;
  seller: bigint;
  fees: Array<{ recipient: Address; amount: bigint; kind: 'opensea' | 'creator' }>;
}

/**
 * Last check before a twin is signed: it mirrors the OSWiki order, sits in a known zone, pays the
 * seller at least the OSWiki payout, and pays only OpenSea (<= 1%) and the verified royalty recipient.
 */
export function assertOpenSeaTwin(twin: OrderComponents, oswiki: OrderComponents, royalty: TwinRoyalty): TwinSummary {
  const fail = (reason: string): never => {
    throw new OpenSeaTwinError(reason);
  };
  const offerer = oswiki.offerer.toLowerCase();
  if (twin.offerer !== offerer) fail('the OpenSea order is for another wallet');
  if (!OPENSEA_ZONES.has(twin.zone) || twin.zoneHash !== ZERO_BYTES32) fail('unknown OpenSea zone');
  if (twin.orderType !== (twin.zone === ZERO_ADDRESS ? OPENSEA_ORDER_TYPE.PARTIAL_OPEN : OPENSEA_ORDER_TYPE.PARTIAL_RESTRICTED)) fail('unexpected OpenSea order type');
  if (twin.conduitKey !== OPENSEA_CONDUIT_KEY || twin.counter !== oswiki.counter || twin.startTime !== oswiki.startTime || twin.endTime !== oswiki.endTime) fail('the OpenSea order does not mirror the OSWiki listing');
  if (twin.offer.length !== 1 || oswiki.offer.length !== 1) fail('exactly one offer item');
  const a = twin.offer[0]!;
  const b = oswiki.offer[0]!;
  if (a.itemType !== b.itemType || a.token !== b.token || a.identifierOrCriteria !== b.identifierOrCriteria || a.startAmount !== b.startAmount || a.endAmount !== b.endAmount) fail('the OpenSea order offers another item');
  const quantity = b.startAmount;

  const [seller, ...legs] = twin.consideration;
  if (!seller || seller.recipient !== offerer) fail('the first OpenSea payment must go to this wallet');
  if (legs.length > 3) fail('too many OpenSea payment legs');
  let total = 0n;
  for (const leg of twin.consideration) {
    if (leg.itemType !== SEAPORT_ITEM_TYPE.NATIVE || leg.token !== ZERO_ADDRESS || leg.identifierOrCriteria !== 0n || leg.startAmount !== leg.endAmount || leg.startAmount <= 0n || leg.startAmount % quantity !== 0n) {
      fail('OpenSea payments must be fixed native amounts');
    }
    total += leg.startAmount;
  }
  if (seller!.startAmount < sellerLeg(oswiki)) fail('OpenSea would pay you less than the OSWiki listing');
  const oswikiTotal = oswiki.consideration.reduce((sum, leg) => sum + leg.startAmount, 0n);
  if (total < oswikiTotal) fail('the OpenSea price is below the OSWiki price');

  const unit = total / quantity;
  const maxOpenSea = ((unit * BigInt(MAX_OPENSEA_FEE_BPS) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR) * quantity;
  let openSeaPaid = 0n;
  let creatorPaid = 0n;
  const fees: TwinSummary['fees'] = [];
  for (const leg of legs) {
    if (leg.recipient === OPENSEA_FEE_RECIPIENT) {
      openSeaPaid += leg.startAmount;
      fees.push({ recipient: leg.recipient, amount: leg.startAmount, kind: 'opensea' });
    } else if (royalty.recipient !== null && leg.recipient === royalty.recipient) {
      creatorPaid += leg.startAmount;
      fees.push({ recipient: leg.recipient, amount: leg.startAmount, kind: 'creator' });
    } else {
      fail(`the OpenSea order pays ${leg.recipient}, which is neither OpenSea nor the verified royalty recipient`);
    }
  }
  if (openSeaPaid > maxOpenSea) fail('the OpenSea fee is above 1%');
  const creatorCap = total * royalty.wei * BPS_DENOMINATOR + total * oswikiTotal * BigInt(CREATOR_FEE_TOLERANCE_BPS) + quantity * oswikiTotal * BPS_DENOMINATOR;
  if (creatorPaid * oswikiTotal * BPS_DENOMINATOR > creatorCap) fail('the OpenSea creator fee is above the OSWiki royalty');
  return { total, seller: seller!.startAmount, fees };
}

/** The linked OpenSea order to cancel with its OSWiki listing, or null when it doesn't check out. */
export function crossListingComponents(
  twin: { orderHash?: unknown; parameters?: unknown; status?: unknown } | null | undefined,
  offerer: string,
): { orderHash: Hex; components: OrderComponents } | null {
  if (!twin || (twin.status !== undefined && twin.status !== 'queued' && twin.status !== 'posted')) return null;
  try {
    const components = pickOrderComponents(twin.parameters as Record<string, unknown>);
    if (components.offerer !== offerer.toLowerCase()) return null;
    const orderHash = hashOrderComponents(components);
    if (typeof twin.orderHash !== 'string' || orderHash !== twin.orderHash.toLowerCase()) return null;
    return { orderHash, components };
  } catch {
    return null;
  }
}
