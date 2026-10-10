import type { CollectionInfo, SaleReference, TokenReference } from '../api.js';
import { MAINNET_ID, NATIVE_SYMBOL, OTHERDEED_CONTRACTS, WRAPPED_SYMBOL, type SupportedChainId } from '../constants.js';
import { ageLabel, native, trimAmount } from '../format.js';
import type { Ctx } from './common.js';
import { floorToWei } from './common.js';

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
      return { wei: high, unavailable: false, warning: `WARNING: the API floor (${native(apiWei, chainId)}) and the cheapest active listing on any marketplace (${native(listingWei, chainId)}) differ by more than ${FLOOR_DISAGREE_FACTOR}x; the floor check uses the higher, ${native(high, chainId)}.` };
    }
    return { wei: apiWei, unavailable: false, warning: null };
  }
  if (apiWei === null && listingWei !== null) {
    return { wei: listingWei, unavailable: info === null, warning: `WARNING: the API reports no floor, but there is an active listing at ${native(listingWei, chainId)}; the floor check uses it.` };
  }
  return { wei: apiWei, unavailable: info === null, warning: null };
}

/** Otherdeed and Otherdeed Expanded share one floor: the lower of the two contracts. */
export async function fetchFloor(ctx: Ctx, chainId: SupportedChainId, contract: string): Promise<{ info: CollectionInfo | null; floor: FloorReference }> {
  const own = contract.toLowerCase();
  const contracts = chainId === MAINNET_ID && OTHERDEED.has(own) ? [own, ...OTHERDEED_CONTRACTS.filter(address => address !== own)] : [own];
  const infos = await Promise.all(contracts.map(address => ctx.api.collection(chainId, address).catch(() => null)));
  const info = infos[0] ?? null;
  const cheapest = await Promise.all(infos.map((entry, i) => (entry?.slug ? ctx.api.cheapestListing(chainId, entry.slug, contracts[i]!).catch(() => null) : null)));
  const lowest = (values: Array<number | null | undefined>) => values.reduce<number | null>((min, value) => (typeof value === 'number' && value > 0 && (min === null || value < min) ? value : min), null);
  const combined = info ? { ...info, floorPrice: lowest(infos.map(entry => entry?.floorPrice)) } : null;
  return { info, floor: resolveFloor(combined, lowest(cheapest), chainId) };
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
      warnings.push(`WARNING: the price is under ${WARN_BELOW_PCT}% of the lowest recent sale reference (${native(lowest, chainId)}). Double-check it with the user.`);
    }
  }
  return { references: parts.join(' · '), warnings };
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
    return `No floor reference for this collection (${why}): the ${pct}% minimum-floor check was skipped because allowNoFloor was set; the price is exactly the explicit number given.`;
  }
  const minimum = (floor * BigInt(pct)) / 100n;
  if (unitPriceWei < minimum) {
    throw new FloorGuardError(`${what} of ${native(unitPriceWei, chainId)} is below ${pct}% of the floor (${native(floor, chainId)}), the OSWIKI_MIN_LIST_FLOOR_PCT limit. Nothing was signed or sent.`);
  }
  return null;
}
