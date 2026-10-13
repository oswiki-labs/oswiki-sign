import { NFT_ABI, SEAPORT_GET_ORDER_STATUS_ABI } from '../abi.js';
import type { CollectionInfo, CollectionListing, SaleReference, TokenReference } from '../api.js';
import { MAINNET_ID, NATIVE_SYMBOL, OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, OTHERDEED_CONTRACTS, SEAPORT_ADDRESS, WRAPPED_NATIVE, WRAPPED_SYMBOL, ZERO_ADDRESS, ZERO_BYTES32, type SupportedChainId } from '../constants.js';
import { ageLabel, native, trimAmount } from '../format.js';
import { verifySeaportOrderSignature } from '../seaport/sign.js';
import { BUY_ASK_ID_RE, loadOrder, marketplaceOf, type BuyMarketplace } from './buy.js';
import type { Ctx } from './common.js';
import { floorToWei, me } from './common.js';

export const REFERENCE_MAX_AGE_DAYS = 90;
export const WARN_BELOW_PCT = 70;
export const FLOOR_DISAGREE_FACTOR = 5n;

const OTHERDEED = new Set(OTHERDEED_CONTRACTS);
const OTHERDEED_KEY_TRAITS = ['Environment', 'Sediment'];

export interface TraitSales {
  label: string;
  sales: SaleReference[] | null;
}

export interface FloorReference {
  wei: bigint | null;
  unavailable: boolean;
  warning: string | null;
}

/** The all-marketplace collection floor, cross-checked against the cheapest active listing on any marketplace; on a >5x split the higher one counts. */
export function resolveFloor(info: CollectionInfo | null, cheapestListing: number | null, chainId: SupportedChainId): FloorReference {
  const apiWei = info ? floorToWei(info.floorPrice) : null;
  const listingWei = floorToWei(cheapestListing);
  if (apiWei !== null && listingWei !== null) {
    const [low, high] = apiWei < listingWei ? [apiWei, listingWei] : [listingWei, apiWei];
    if (high > low * FLOOR_DISAGREE_FACTOR) {
      return { wei: high, unavailable: false, warning: `The API floor (${native(apiWei, chainId)}) and the cheapest active listing on any marketplace (${native(listingWei, chainId)}) differ by more than ${FLOOR_DISAGREE_FACTOR}x; the floor check uses the higher, ${native(high, chainId)}.` };
    }
    return { wei: apiWei, unavailable: false, warning: null };
  }
  if (apiWei === null && listingWei !== null) {
    return { wei: listingWei, unavailable: info === null, warning: `The API reports no floor, but there is an active listing at ${native(listingWei, chainId)}; the floor check uses it.` };
  }
  return { wei: apiWei, unavailable: info === null, warning: null };
}

export interface FloorGroup {
  contracts: string[];
  infos: Array<CollectionInfo | null>;
}

/** Otherdeed and Otherdeed Expanded share one floor. */
export async function fetchFloorGroup(ctx: Ctx, chainId: SupportedChainId, contract: string): Promise<FloorGroup> {
  const own = contract.toLowerCase();
  const contracts = chainId === MAINNET_ID && OTHERDEED.has(own) ? [own, ...OTHERDEED_CONTRACTS.filter(address => address !== own)] : [own];
  const infos = await Promise.all(contracts.map(address => ctx.api.collection(chainId, address).catch(() => null)));
  return { contracts, infos };
}

/** The lower of the shared contracts' API floors, cross-checked against the cheapest API listing. */
export async function fetchFloor(ctx: Ctx, chainId: SupportedChainId, contract: string, group?: FloorGroup): Promise<{ info: CollectionInfo | null; floor: FloorReference }> {
  const { contracts, infos } = group ?? await fetchFloorGroup(ctx, chainId, contract);
  const info = infos[0] ?? null;
  const cheapest = await Promise.all(infos.map((entry, i) => (entry?.slug ? ctx.api.cheapestListing(chainId, entry.slug, contracts[i]!).catch(() => null) : null)));
  const lowest = (values: Array<number | null | undefined>) => values.reduce<number | null>((min, value) => (typeof value === 'number' && value > 0 && (min === null || value < min) ? value : min), null);
  const combined = info ? { ...info, floorPrice: lowest(infos.map(entry => entry?.floorPrice)) } : null;
  return { info, floor: resolveFloor(combined, lowest(cheapest), chainId) };
}

export const VERIFIED_FLOOR_CANDIDATES = 5;
export const SALES_WINDOW_DAYS = 30;
export const SALES_MIN_COUNT = 3;
export const FLOOR_MIN_MEDIAN_PCT = 70;

/** Gondi listings may be priced in wrapped native; the buy flow approves exactly what Seaport pulls. */
export function isBuyableRow(row: CollectionListing, chainId: SupportedChainId): boolean {
  if (!row.buyable || !BUY_ASK_ID_RE.test(row.askId)) return false;
  let market: BuyMarketplace;
  try {
    market = marketplaceOf(row.askId);
  } catch {
    return false;
  }
  if (row.marketplace !== market) return false;
  return row.currencyContract === null || row.currencyContract === ZERO_ADDRESS || (market === 'gondi' && row.currencyContract === WRAPPED_NATIVE[chainId]);
}

export interface FloorListing {
  askId: string;
  contract: string;
  tokenId: string;
  marketplace: BuyMarketplace;
  unitWei: bigint;
}

export interface VerifiedFloor {
  wei: bigint | null;
  listing: FloorListing | null;
  checked: number;
  salesMedianWei: bigint | null;
  salesCount: number;
  problem: string | null;
}

/** Order data checked like a buy (guards, struct hash under the live counter), plus signature, status, expiry, seller balance and approval. */
export async function fillableListing(ctx: Ctx, chainId: SupportedChainId, askId: string, contract: string): Promise<FloorListing | null> {
  try {
    const loaded = await loadOrder(ctx, chainId, askId);
    if (loaded.contract.toLowerCase() !== contract.toLowerCase()) return null;
    const params = loaded.order.parameters;
    const nowSeconds = BigInt(Math.floor(ctx.now() / 1000));
    if (params.startTime > nowSeconds || params.endTime <= nowSeconds) return null;
    if (!(await verifySeaportOrderSignature({ chainId, offerer: params.offerer, orderHash: loaded.orderHash, signature: loaded.order.signature }))) return null;
    const conduitKey = params.conduitKey.toLowerCase();
    const operator = conduitKey === OPENSEA_CONDUIT_KEY ? OPENSEA_CONDUIT_ADDRESS : conduitKey === ZERO_BYTES32 ? SEAPORT_ADDRESS : null;
    if (!operator) return null;
    const client = ctx.chains.client(chainId);
    const item = params.offer[0]!;
    const [status, holds, approved] = await Promise.all([
      client.readContract({ address: SEAPORT_ADDRESS, abi: SEAPORT_GET_ORDER_STATUS_ABI, functionName: 'getOrderStatus', args: [loaded.orderHash] }),
      item.itemType === 3
        ? client.readContract({ address: item.token, abi: NFT_ABI, functionName: 'balanceOf', args: [params.offerer, item.identifierOrCriteria] }).then(balance => balance >= loaded.quantity)
        : client.readContract({ address: item.token, abi: NFT_ABI, functionName: 'ownerOf', args: [item.identifierOrCriteria] }).then(owner => owner.toLowerCase() === params.offerer.toLowerCase()),
      client.readContract({ address: item.token, abi: NFT_ABI, functionName: 'isApprovedForAll', args: [params.offerer, operator] }),
    ]);
    const [, cancelled, filled, size] = status;
    if (cancelled || (size > 0n && filled >= size) || !holds || approved !== true) return null;
    return { askId, contract: loaded.contract.toLowerCase(), tokenId: loaded.tokenId, marketplace: loaded.marketplace, unitWei: loaded.value / (loaded.quantity > 0n ? loaded.quantity : 1n) };
  } catch {
    return null;
  }
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/**
 * Floor for floorPct pricing: the cheapest of the API's cheapest few listings that oswiki-sign itself verified as fillable,
 * so a fake API listing cannot pull the price down. A low floor against the 30-day median sale is flagged as a problem.
 */
export async function fetchVerifiedFloor(ctx: Ctx, chainId: SupportedChainId, group: FloorGroup): Promise<VerifiedFloor> {
  const wallet = me(ctx);
  const [listed, sales] = await Promise.all([
    Promise.all(group.infos.map((info, i) => (info?.slug
      ? ctx.api.collectionListings(chainId, info.slug, 50).then(rows => rows.filter(row => row.contract === group.contracts[i])).catch(() => [])
      : Promise.resolve([])))),
    Promise.all(group.contracts.map(contract => ctx.api.sales(chainId, contract, {}, 50).catch(() => []))),
  ]);
  const seen = new Set<string>();
  const candidates = listed.flat()
    .filter((row) => {
      if (row.maker === wallet || !isBuyableRow(row, chainId) || seen.has(row.askId)) return false;
      seen.add(row.askId);
      return true;
    })
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
    .slice(0, VERIFIED_FLOOR_CANDIDATES);
  const verified = (await Promise.all(candidates.map(row => fillableListing(ctx, chainId, row.askId, row.contract)))).filter((entry): entry is FloorListing => entry !== null);
  const listing = verified.reduce<FloorListing | null>((min, entry) => (min === null || entry.unitWei < min.unitWei ? entry : min), null);

  const nowMs = ctx.now();
  const recent = sales.flat().flatMap((sale) => {
    const age = ageLabel(sale.timestamp, nowMs);
    return inChainCurrency(sale.currency, chainId) && age.days !== null && age.days <= SALES_WINDOW_DAYS ? [toWei(sale.price)] : [];
  });
  const salesMedianWei = recent.length >= SALES_MIN_COUNT ? median(recent) : null;

  let problem: string | null = null;
  if (listing === null) {
    problem = candidates.length === 0
      ? 'the OSWiki API returned no active listing that oswiki-sign can check'
      : `none of the ${candidates.length} cheapest listings the OSWiki API returned could be verified as fillable (order data, signature, seller's counter, order status, ownership, approval)`;
  } else if (salesMedianWei !== null && listing.unitWei * 100n < salesMedianWei * BigInt(FLOOR_MIN_MEDIAN_PCT)) {
    problem = `the verified floor ${native(listing.unitWei, chainId)} is under ${FLOOR_MIN_MEDIAN_PCT}% of the ${SALES_WINDOW_DAYS}-day median sale price ${native(salesMedianWei, chainId)} (${recent.length} sales)`;
  }
  return { wei: listing?.unitWei ?? null, listing, checked: candidates.length, salesMedianWei, salesCount: recent.length, problem };
}

export interface CollectionReferences {
  floor: FloorReference;
  info: CollectionInfo | null;
  tokens: Map<string, TokenReference> | null;
  traitSales: Map<string, TraitSales>;
}

/**
 * Key traits only where we know which traits drive price (Otherdeed: Environment + Sediment);
 * token responses carry no per-trait supply, so other collections get no trait reference.
 */
export function keyTraits(chainId: SupportedChainId, contract: string, token: TokenReference | undefined): Record<string, string> | null {
  if (chainId !== MAINNET_ID || !OTHERDEED.has(contract.toLowerCase()) || !token) return null;
  const traits: Record<string, string> = {};
  for (const type of OTHERDEED_KEY_TRAITS) {
    const value = token.attributes.find(attribute => attribute.traitType === type)?.value;
    if (value) traits[type] = value;
  }
  return Object.keys(traits).length > 0 ? traits : null;
}

function traitKey(traits: Record<string, string>): string {
  return Object.entries(traits).map(([type, value]) => `${type}=${value}`).join('&');
}

/** Per contract: collection (floor), one batched tokens call, then one trait-filtered sales call per distinct key-trait set. */
export async function fetchCollectionReferences(ctx: Ctx, chainId: SupportedChainId, contract: string, tokenIds: string[]): Promise<CollectionReferences> {
  const ids = [...new Set(tokenIds)].slice(0, 100);
  const [{ info, floor }, tokens] = await Promise.all([
    fetchFloor(ctx, chainId, contract),
    ctx.api.tokens(chainId, contract, ids).then(rows => new Map(rows.map(row => [row.tokenId, row]))).catch(() => null),
  ]);
  const wanted = new Map<string, Record<string, string>>();
  for (const id of ids) {
    const traits = keyTraits(chainId, contract, tokens?.get(id));
    if (traits) wanted.set(traitKey(traits), traits);
  }
  const traitSales = new Map<string, TraitSales>();
  await Promise.all([...wanted.entries()].map(async ([key, traits]) => {
    const sales = await ctx.api.sales(chainId, contract, traits, 50).catch(() => null);
    traitSales.set(key, { label: Object.values(traits).join(' / '), sales });
  }));
  return { info, floor, tokens, traitSales };
}

function inChainCurrency(currency: string, chainId: SupportedChainId): boolean {
  const upper = currency.toUpperCase();
  return upper === '' || upper === NATIVE_SYMBOL[chainId] || upper === WRAPPED_SYMBOL[chainId];
}

function toWei(amount: number): bigint {
  return BigInt(Math.round(amount * 1e9)) * 10n ** 9n;
}

export interface PriceCheck {
  references: string;
  warnings: string[];
}

/** Warns, never blocks, when the price is under 70% of the lowest real sale reference within 90 days. */
export function checkListingPrice(refs: CollectionReferences, input: { chainId: SupportedChainId; contract: string; tokenId: string; unitPriceWei: bigint; nowMs: number }): PriceCheck {
  const { chainId, unitPriceWei, nowMs } = input;
  const symbol = NATIVE_SYMBOL[chainId]!;
  const parts: string[] = [];
  const referenceWei: bigint[] = [];

  const token = refs.tokens?.get(input.tokenId);
  if (refs.tokens === null || !token) {
    parts.push('last sale unavailable');
  } else if (!token.lastSale) {
    parts.push('no previous sale');
  } else {
    const sale = token.lastSale;
    const age = ageLabel(sale.timestamp, nowMs);
    parts.push(`last sale ${trimAmount(toWei(sale.price))} ${sale.currency || symbol} (${age.label})`);
    if (inChainCurrency(sale.currency, chainId) && age.days !== null && age.days <= REFERENCE_MAX_AGE_DAYS) referenceWei.push(toWei(sale.price));
  }

  const traits = keyTraits(chainId, input.contract, token);
  const traitSales = traits ? refs.traitSales.get(traitKey(traits)) : undefined;
  if (traitSales) {
    if (traitSales.sales === null) {
      parts.push(`"${traitSales.label}" sales unavailable`);
    } else {
      const recent = traitSales.sales.flatMap((sale) => {
        const age = ageLabel(sale.timestamp, nowMs);
        if (!inChainCurrency(sale.currency, chainId) || age.days === null || age.days > REFERENCE_MAX_AGE_DAYS || sale.tokenId === input.tokenId) return [];
        return [{ wei: toWei(sale.price), days: age.days }];
      });
      if (recent.length === 0) {
        parts.push(`no "${traitSales.label}" sales in ${REFERENCE_MAX_AGE_DAYS}d`);
      } else {
        const sorted = recent.map(sale => sale.wei).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const low = sorted[0]!;
        const high = sorted[sorted.length - 1]!;
        const newest = Math.min(...recent.map(sale => sale.days));
        parts.push(`recent "${traitSales.label}" sales ${low === high ? trimAmount(low) : `${trimAmount(low)}-${trimAmount(high)}`} ${symbol} (${recent.length}, newest ${newest}d ago)`);
        referenceWei.push(low);
      }
    }
  }

  const floor = refs.floor.wei;
  parts.push(floor !== null ? `floor ${native(floor, chainId)}` : refs.floor.unavailable ? 'floor unavailable' : 'no floor (no active listings)');

  const warnings: string[] = refs.floor.warning ? [refs.floor.warning] : [];
  if (referenceWei.length > 0) {
    const lowest = referenceWei.reduce((min, wei) => (wei < min ? wei : min));
    if (unitPriceWei * 100n < lowest * BigInt(WARN_BELOW_PCT)) {
      warnings.push(`The price is under ${WARN_BELOW_PCT}% of the lowest recent sale reference (${native(lowest, chainId)}).`);
    }
  }
  return { references: parts.join(' · '), warnings };
}

/** Value given up below the floor per unit; without a floor the whole price counts. */
export function belowFloor(floorWei: bigint | null, priceWei: bigint): bigint {
  if (floorWei === null) return priceWei;
  return floorWei > priceWei ? floorWei - priceWei : 0n;
}

export function belowFloorLabel(floorWei: bigint | null, belowWei: bigint, chainId: SupportedChainId): string {
  return floorWei === null
    ? `No floor: the full ${native(belowWei, chainId)} counts toward today's below-floor budget.`
    : `${native(belowWei, chainId)} below the floor, counted toward today's below-floor budget.`;
}

export class FloorGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FloorGuardError';
  }
}

/** OSWIKI_MIN_LIST_FLOOR_PCT: refuses prices far under the floor; without a floor it refuses unless the user explicitly allowed that. */
export function applyMinFloor(floorRef: FloorReference, unitPriceWei: bigint, pct: number, chainId: SupportedChainId, what: string, allowNoFloor = false): string | null {
  if (pct <= 0) return null;
  const floor = floorRef.wei;
  if (floor === null) {
    const why = floorRef.unavailable ? 'the floor could not be loaded' : 'the collection has no active listings';
    if (allowNoFloor !== true) {
      throw new FloorGuardError(`No floor reference for this collection (${why}), so the ${pct}% minimum-floor check (OSWIKI_MIN_LIST_FLOOR_PCT) cannot run. Nothing was signed or sent. Tell the user there is no floor, confirm ${native(unitPriceWei, chainId)} with them, and only if they explicitly accept it without a floor check run the preview again with allowNoFloor: true.`);
    }
    return `No floor reference for this collection (${why}): the ${pct}% minimum-floor check was skipped because you allowed it; the price is exactly the number you gave.`;
  }
  const minimum = (floor * BigInt(pct)) / 100n;
  if (unitPriceWei < minimum) {
    throw new FloorGuardError(`${what} of ${native(unitPriceWei, chainId)} is below ${pct}% of the floor (${native(floor, chainId)}), the OSWIKI_MIN_LIST_FLOOR_PCT limit. Nothing was signed or sent.`);
  }
  return null;
}
