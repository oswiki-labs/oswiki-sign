import { formatUnits, type Address } from 'viem';

import { NFT_ABI } from '../abi.js';
import { sanitizeServerText, type CollectionMatch } from '../api.js';
import type { SupportedChainId } from '../constants.js';
import { native, parsePositiveAmount } from '../format.js';
import { addCardText, addCardWarning, chainLabel, shortHex, type CardPreview } from '../format-card.js';
import { MAX_LISTINGS_PER_REQUEST } from '../seaport/listing.js';
import { previewAcceptOffer, type AcceptPlan } from './accept.js';
import { MAX_BUY_ITEMS, previewBuy, type BuyPlan } from './buy.js';
import { MAX_CANCELS, previewCancel, type CancelPlan } from './cancel.js';
import { ADDRESS_RE, assertBuyingEnabled, assertCollectionAllowed, chainOf, floorToWei, GuardError, me, readIsErc1155, TOKEN_ID_RE, type Ctx } from './common.js';
import { previewListing, type ListingInput, type ListingPlan } from './listing.js';
import { previewOffer, type OfferInput, type OfferPlan } from './offer.js';
import { fetchFloor, fetchFloorGroup, fetchVerifiedFloor, isBuyableRow, type FloorReference } from './references.js';
import { MAX_TRANSFER_ITEMS, previewTransfer, type TransferInput, type TransferPlan } from './transfer.js';

export interface ResolvedCollection {
  address: Address;
  name: string;
  slug: string;
  verified: boolean | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_CANDIDATES = 5;

export function verifiedBadge(verified: boolean | null): string {
  return verified === true ? '✓ verified' : verified === false ? 'NOT verified' : 'verified status unknown';
}

export function collectionLabel(collection: ResolvedCollection): string {
  return collection.name || shortHex(collection.address);
}

/** API names and slugs reach the card and the AI: no control or invisible chars, no quotes or angle brackets, slugs strictly shaped. */
export function cleanName(value: unknown): string {
  return sanitizeServerText(value, 80).replace(/["`<>]/g, '\'');
}

export function cleanSlug(value: unknown): string {
  return typeof value === 'string' && SLUG_RE.test(value) ? value.toLowerCase() : '';
}

function exactName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function candidateText(row: CollectionMatch): string {
  const slug = cleanSlug(row.slug);
  return `"${cleanName(row.name) || shortHex(row.address)}" (${slug ? `slug ${slug}, ` : ''}${row.address}, ${verifiedBadge(row.verified)})`;
}

/**
 * Exact slug or 0x address on this chain, else an exact name that is verified. Anything
 * looser is refused with the closest candidates, so a copycat name never resolves silently.
 */
export async function resolveCollection(ctx: Ctx, chainId: SupportedChainId, reference: string): Promise<ResolvedCollection> {
  const resolved = await resolveAny(ctx, chainId, reference);
  if (ctx.config.confirmMode === 'off' && resolved.verified !== true && ctx.config.trustedCollections?.has(resolved.address) !== true) {
    throw new GuardError(`${collectionLabel(resolved)} is not verified. If the user trusts it, they can add it with update_limits trustedCollections (approved in oswiki-sign's dialog). Contract ${resolved.address} on ${chainLabel(chainId)}${resolved.verified === false ? '' : ', verified status unknown'}; with confirmation off oswiki-sign resolves only verified or trusted collections. Nothing was signed or sent.`);
  }
  return resolved;
}

async function resolveAny(ctx: Ctx, chainId: SupportedChainId, reference: string): Promise<ResolvedCollection> {
  const value = typeof reference === 'string' ? reference.trim() : '';
  if (value === '' || value.length > 200) throw new GuardError('collection must be a slug, an exact collection name or a 0x address. Nothing was signed or sent.');
  if (ADDRESS_RE.test(value)) {
    const address = value.toLowerCase() as Address;
    const info = await ctx.api.findCollection(chainId, address).catch(() => null);
    return info && info.address === address
      ? { address, name: cleanName(info.name), slug: cleanSlug(info.slug), verified: info.verified ?? null }
      : { address, name: '', slug: '', verified: null };
  }
  if (SLUG_RE.test(value)) {
    const info = await ctx.api.findCollection(chainId, value);
    if (info && ADDRESS_RE.test(info.address)) return { address: info.address.toLowerCase() as Address, name: cleanName(info.name), slug: cleanSlug(info.slug), verified: info.verified ?? null };
  }
  const rows = await ctx.api.searchCollections(chainId, value);
  const wanted = exactName(value);
  const exact = rows.filter(row => exactName(row.name) === wanted);
  const verified = [...new Map(exact.filter(row => row.verified === true).map(row => [row.address, row])).values()];
  const shown = sanitizeServerText(value, 80);
  if (verified.length === 1) {
    const row = verified[0]!;
    return { address: row.address as Address, name: cleanName(row.name), slug: cleanSlug(row.slug), verified: true };
  }
  const chain = chainLabel(chainId);
  if (verified.length > 1) {
    throw new GuardError(`"${shown}" matches ${verified.length} verified collections on ${chain}: ${verified.slice(0, MAX_CANDIDATES).map(candidateText).join('; ')}. Ask the user which one and pass its slug or 0x address. Nothing was signed or sent.`);
  }
  const why = exact.length > 0 ? ' (only unverified collections carry exactly this name, and a name alone is accepted only for a verified one)' : '';
  const hint = rows.length > 0 ? ` Did you mean: ${rows.slice(0, MAX_CANDIDATES).map(candidateText).join('; ')}?` : '';
  throw new GuardError(`No collection on ${chain} matches "${shown}" exactly${why}.${hint} Confirm the collection with the user and pass its slug or 0x address. Nothing was signed or sent.`);
}

/** Per-call cache of collection references, remembering which were resolved for the card. */
export class CollectionRefs {
  readonly used = new Map<string, ResolvedCollection>();
  private readonly cache = new Map<string, Promise<ResolvedCollection>>();

  constructor(private readonly ctx: Ctx, readonly chainId: SupportedChainId) {}

  async resolve(reference: string): Promise<ResolvedCollection> {
    const key = String(reference ?? '').trim().toLowerCase();
    let pending = this.cache.get(key);
    if (!pending) {
      pending = resolveCollection(this.ctx, this.chainId, reference);
      this.cache.set(key, pending);
    }
    const resolved = await pending;
    this.used.set(resolved.address, resolved);
    return resolved;
  }

  async contract(input: { contract?: string; collection?: string }, where: string): Promise<string> {
    const hasContract = typeof input.contract === 'string' && input.contract !== '';
    const hasCollection = typeof input.collection === 'string' && input.collection !== '';
    if (hasContract === hasCollection) throw new GuardError(`${where}: pass either contract (0x address) or collection (slug, exact name or 0x address). Nothing was signed or sent.`);
    return hasContract ? input.contract! : (await this.resolve(input.collection!)).address;
  }

  lines(): string[] {
    return [...this.used.values()].map(collection => `Collection: ${collectionLabel(collection)} · ${verifiedBadge(collection.verified)}`);
  }

  warnings(): string[] {
    return [...this.used.values()].filter(collection => collection.verified !== true).map(collection => `${collectionLabel(collection)} is not a verified collection. Make sure this is the contract the user means: ${collection.address}`);
  }
}

function decorate<P>(preview: CardPreview<P>, lines: string[], warnings: string[], notes: string[] = []): CardPreview<P> {
  let text = preview.text;
  for (const line of lines) text = addCardText(text, line);
  for (const warning of warnings) text = addCardWarning(text, warning);
  return { ...preview, text, note: [...(preview.note ?? []), ...notes] };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export interface OwnedPick {
  tokenIds: string[];
  skipped: number;
}

/** ERC-721 tokens of this wallet from the index, each confirmed with ownerOf so a stale index row is dropped. */
export async function pickOwnedTokens(ctx: Ctx, chainId: SupportedChainId, collection: ResolvedCollection, options: { count?: number; all?: boolean; max: number; skip?: Set<string> }): Promise<OwnedPick> {
  const name = collectionLabel(collection);
  const all = options.all === true;
  if ((options.count === undefined) === !all) throw new GuardError(`For ${name} pass either count or all: true. Nothing was signed or sent.`);
  if (!all && (!Number.isInteger(options.count) || options.count! < 1 || options.count! > options.max)) throw new GuardError(`count must be a whole number from 1 to ${options.max}. Nothing was signed or sent.`);
  const client = ctx.chains.client(chainId);
  if (await readIsErc1155(client, collection.address)) throw new GuardError(`${name} is ERC-1155: count / all only pick ERC-721 tokens. Pass its token ids explicitly. Nothing was signed or sent.`);
  const skip = options.skip ?? new Set<string>();
  const need = all ? options.max + 1 : options.count!;
  const owner = me(ctx);
  const { tokenIds } = await ctx.api.ownedTokenIds(chainId, collection.address, owner, Math.min(need + skip.size + 50, 2000));
  const candidates = tokenIds.filter(id => !skip.has(id)).sort((a, b) => {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const picked: string[] = [];
  for (let i = 0; i < candidates.length && picked.length < need; i += 25) {
    const batch = candidates.slice(i, i + 25);
    const owners = await Promise.all(batch.map(id => client.readContract({ address: collection.address, abi: NFT_ABI, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null)));
    batch.forEach((id, j) => {
      if (picked.length < need && typeof owners[j] === 'string' && owners[j]!.toLowerCase() === owner) picked.push(id);
    });
  }
  if (all && picked.length > options.max) throw new GuardError(`This wallet holds more than ${options.max} ${name}${skip.size > 0 ? ' that qualify' : ''}; pass count (at most ${options.max}) instead of all. Nothing was signed or sent.`);
  if (picked.length === 0) throw new GuardError(`This wallet holds no ${name}${skip.size > 0 ? ' that is not already listed by it' : ''} on ${chainLabel(chainId)} (OSWiki index checked against the chain). Nothing was signed or sent.`);
  return { tokenIds: picked, skipped: tokenIds.length - candidates.length };
}

export interface BuyInput {
  chainId: number;
  askIds?: string[];
  collection?: string;
  count?: number;
  maxPrice?: unknown;
}

const BUY_RETRIES = 3;
const ADVERTISED_TOLERANCE_WEI = 10n ** 9n;

export async function previewBuyAuto(ctx: Ctx, input: BuyInput): Promise<CardPreview<BuyPlan>> {
  const byCollection = input.collection !== undefined;
  if (!byCollection) {
    if (input.count !== undefined || input.maxPrice !== undefined) throw new GuardError('count and maxPrice go with collection. Nothing was sent.');
    return previewBuy(ctx, { chainId: input.chainId, askIds: input.askIds ?? [] });
  }
  if ((input.askIds ?? []).length > 0) throw new GuardError('Pass either askIds or collection, not both. Nothing was sent.');
  const chainId = chainOf(input.chainId);
  assertBuyingEnabled(ctx.config, chainId);
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_BUY_ITEMS) throw new GuardError(`count must be 1 to ${MAX_BUY_ITEMS}. Nothing was sent.`);
  const maxWei = input.maxPrice === undefined ? null : parsePositiveAmount(input.maxPrice, 'maxPrice');
  const refs = new CollectionRefs(ctx, chainId);
  const collection = await refs.resolve(input.collection!);
  assertCollectionAllowed(ctx.config, collection.address);
  const name = collectionLabel(collection);
  if (!collection.slug) throw new GuardError(`The OSWiki API has no listings index for ${name} (${collection.address}). Nothing was sent.`);

  const rows = await ctx.api.collectionListings(chainId, collection.slug, 100);
  const wallet = me(ctx);
  let own = 0;
  let unsupported = 0;
  let aboveMax = 0;
  const tokens = new Set<string>();
  const pool = rows.filter((row) => {
    if (row.contract !== collection.address) return false;
    if (row.maker === wallet) {
      own++;
      return false;
    }
    const priceWei = floorToWei(row.price);
    if (!isBuyableRow(row) || priceWei === null) {
      unsupported++;
      return false;
    }
    if (maxWei !== null && priceWei > maxWei) {
      aboveMax++;
      return false;
    }
    if (tokens.has(row.tokenId)) return false;
    tokens.add(row.tokenId);
    return true;
  });
  const advertisedWei = new Map(pool.map(row => [row.askId, floorToWei(row.price)!]));
  const skippedText = [own > 0 ? `${own} of your own` : '', unsupported > 0 ? `${unsupported} not buyable here (marketplace or order type)` : '', aboveMax > 0 ? `${aboveMax} above maxPrice` : ''].filter(Boolean).join(', ');

  const dropped = new Set<string>();
  let preview: CardPreview<BuyPlan> | null = null;
  let picked: typeof pool = [];
  for (let attempt = 0; attempt <= BUY_RETRIES && !preview; attempt++) {
    picked = pool.filter(row => !dropped.has(row.askId)).slice(0, count);
    if (picked.length === 0) {
      throw new GuardError(`No buyable listing of ${name} on ${chainLabel(chainId)}${maxWei !== null ? ` at or under ${native(maxWei, chainId)}` : ''}${skippedText ? ` (skipped: ${skippedText})` : ''}. Nothing was sent.`);
    }
    let result: CardPreview<BuyPlan>;
    try {
      result = await previewBuy(ctx, { chainId, askIds: picked.map(row => row.askId) });
    } catch (err) {
      const message = String((err as { message?: unknown } | null)?.message ?? '').toLowerCase();
      const bad = picked.filter(row => message.includes(row.askId));
      if (bad.length === 0 || attempt === BUY_RETRIES) throw err;
      for (const row of bad) dropped.add(row.askId);
      continue;
    }
    const foreign = result.plan.entries.filter(entry => entry.contract.toLowerCase() !== collection.address);
    if (foreign.length > 0) throw new GuardError(`${foreign.map(entry => entry.askId).join(', ')} sells an NFT of another contract (${foreign[0]!.contract}), not ${name} (${collection.address}). Nothing was sent.`);
    const misreported = result.plan.entries.filter((entry) => {
      const advertised = advertisedWei.get(entry.askId);
      const unit = entry.value / (entry.quantity > 0n ? entry.quantity : 1n);
      return advertised === undefined || unit > advertised + ADVERTISED_TOLERANCE_WEI;
    });
    const dear = maxWei === null ? [] : result.plan.entries.filter(entry => entry.value > maxWei * (entry.quantity > 0n ? entry.quantity : 1n));
    if (misreported.length + dear.length > 0) {
      if (attempt === BUY_RETRIES) {
        throw new GuardError(misreported.length > 0
          ? `The checked order price of ${misreported.map(entry => entry.askId).join(', ')} is above the price the OSWiki API advertised for it. Nothing was sent.`
          : `The checked order price of ${dear.map(entry => entry.askId).join(', ')} is above maxPrice ${native(maxWei!, chainId)}. Nothing was sent.`);
      }
      for (const entry of [...misreported, ...dear]) dropped.add(entry.askId);
      continue;
    }
    preview = result;
  }
  if (!preview) throw new GuardError(`Could not find ${count} buyable listing(s) of ${name}. Nothing was sent.`);

  const found = preview.plan.entries.length;
  const lines = [`Picked by oswiki-sign: the ${found === 1 ? 'cheapest buyable listing' : `${found} cheapest buyable listings`} of ${name}${maxWei !== null ? `, each at most ${native(maxWei, chainId)}` : ''}.`];
  const notes = [`Picked from the collection's active listings (cheapest first): ${preview.plan.entries.map(entry => entry.askId).join(', ')}.`];
  if (found < count) {
    const short = `Only ${plural(found, 'buyable listing')} found, you asked for ${count}${skippedText ? ` (skipped: ${skippedText})` : ''}.`;
    lines.push(short);
    notes.push(`${short} Tell the user before executing.`);
  }
  return decorate(preview, lines, [], notes);
}

type ListingItemInput = { contract?: string; collection?: string; tokenId: string; price?: unknown; floorPct?: number; quantity?: number };

export interface ListingAutoInput extends Omit<ListingInput, 'items'> {
  items?: ListingItemInput[];
  collection?: string;
  count?: number;
  all?: boolean;
  price?: unknown;
  floorPct?: number;
}

function assertFloorPct(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1000 || Math.round(value * 100) !== value * 100) {
    throw new GuardError(`${where}floorPct must be a number from 1 to 1000 (at most 2 decimals), e.g. 110 for 10% above the floor. Nothing was signed.`);
  }
  return value;
}

const PRICE_STEP = 10n ** 12n;

/** floor x pct, rounded UP to 6 decimals so the price never lands under the asked percentage. */
export function floorPctPrice(floorWei: bigint, pct: number): bigint {
  const raw = (floorWei * BigInt(Math.round(pct * 100)) + 9999n) / 10000n;
  return ((raw + PRICE_STEP - 1n) / PRICE_STEP) * PRICE_STEP;
}

function noFloorText(name: string, floor: FloorReference): string {
  const why = floor.unavailable ? 'the floor could not be loaded' : 'the collection has no active listings';
  return `${name} has no floor right now (${why}), so floorPct cannot set a price; oswiki-sign never guesses one. Nothing was signed. Ask the user for an explicit price.`;
}

const MARKET_NAME: Record<string, string> = { oswiki: 'OSWiki', opensea: 'OpenSea' };

interface PricingFloor {
  wei: bigint;
  name: string;
  label: string;
  source: string | null;
  warning: string | null;
}

/** Off mode prices only from a verified, sales-consistent floor; human mode may fall back to the API floor with a warning. */
async function pricingFloor(ctx: Ctx, chainId: SupportedChainId, contract: string, knownName: string, offMode: boolean): Promise<PricingFloor> {
  const group = await fetchFloorGroup(ctx, chainId, contract);
  const name = cleanName(group.infos[0]?.name) || knownName || shortHex(contract);
  const verified = await fetchVerifiedFloor(ctx, chainId, group);
  const listing = verified.listing;
  const source = listing ? `Floor set by ${MARKET_NAME[listing.marketplace] ?? listing.marketplace} listing ${shortHex(listing.askId.replace(/^oswiki-/, ''))} (#${listing.tokenId}), checked fillable by oswiki-sign.` : null;
  if (verified.problem === null && verified.wei !== null) return { wei: verified.wei, name, label: 'verified floor', source, warning: null };
  if (offMode) {
    throw new GuardError(`floorPct for ${name} needs a floor oswiki-sign can verify, but ${verified.problem}. With confirmation off nobody reviews this price, so nothing was signed. Ask the user for an explicit price.`);
  }
  if (verified.wei !== null) return { wei: verified.wei, name, label: 'verified floor', source, warning: `floorPct price check failed: ${verified.problem}. Make sure this price is what the user wants.` };
  const { floor } = await fetchFloor(ctx, chainId, contract, group);
  if (floor.wei === null) throw new GuardError(noFloorText(name, floor));
  const extra = floor.warning ? ` ${floor.warning}` : '';
  return { wei: floor.wei, name, label: 'UNVERIFIED API floor', source: null, warning: `The floor for this floorPct price could not be verified: ${verified.problem}. It uses the OSWiki API floor ${native(floor.wei, chainId)}, which a wrong listing can pull down.${extra} Make sure this price is what the user wants.` };
}

export async function previewListingAuto(ctx: Ctx, input: ListingAutoInput): Promise<CardPreview<ListingPlan>> {
  const chainId = chainOf(input.chainId);
  const hasItems = Array.isArray(input.items) && input.items.length > 0;
  const byCollection = input.collection !== undefined;
  if (hasItems === byCollection) throw new GuardError('Pass either items, or collection with count or all: true. Nothing was signed.');
  if (input.price !== undefined && input.floorPct !== undefined) throw new GuardError('Pass either price or floorPct, not both. Nothing was signed.');
  if (!byCollection && (input.count !== undefined || input.all !== undefined)) throw new GuardError('count and all go with collection. Nothing was signed.');
  const refs = new CollectionRefs(ctx, chainId);
  const offMode = ctx.config.confirmMode === 'off';
  const lines: string[] = [];
  const notes: string[] = [];
  const floorWarnings: string[] = [];

  let raw: Array<{ contract: string; tokenId: string; quantity?: number; price?: unknown; floorPct?: number }>;
  if (hasItems) {
    raw = await Promise.all(input.items!.map(async (item, i) => {
      if (item.price !== undefined && item.floorPct !== undefined) throw new GuardError(`items[${i}]: pass either price or floorPct, not both. Nothing was signed.`);
      const own = item.price !== undefined || item.floorPct !== undefined;
      return {
        contract: await refs.contract(item, `items[${i}]`),
        tokenId: item.tokenId,
        quantity: item.quantity,
        price: own ? item.price : input.price,
        floorPct: own ? item.floorPct : input.floorPct,
      };
    }));
  } else {
    if (input.floorPct !== undefined && offMode) {
      throw new GuardError('With confirmation off, count / all cannot be combined with floorPct: the OSWiki index picks which tokens are listed, and a rare one could go out at the floor price unseen. Pass explicit items (token ids) or an explicit price, or let the user review it with human confirmation. Nothing was signed.');
    }
    const collection = await refs.resolve(input.collection!);
    assertCollectionAllowed(ctx.config, collection.address);
    const mine = await ctx.api.makerListings(chainId, me(ctx)).catch(() => null);
    const skip = new Set((mine ?? []).filter(row => row.contract === collection.address && row.tokenId !== null).map(row => row.tokenId!));
    const pick = await pickOwnedTokens(ctx, chainId, collection, { count: input.count, all: input.all, max: MAX_LISTINGS_PER_REQUEST, skip });
    raw = pick.tokenIds.map(tokenId => ({ contract: collection.address, tokenId, price: input.price, floorPct: input.floorPct }));
    const name = collectionLabel(collection);
    lines.push(`Picked by oswiki-sign: ${input.all ? `all ${plural(pick.tokenIds.length, 'token')}` : plural(pick.tokenIds.length, 'token')} of your ${name}: ${pick.tokenIds.map(id => `#${id}`).join(', ')}.`);
    if (pick.skipped > 0) lines.push(`Skipped ${plural(pick.skipped, 'token')} you already list on OSWiki.`);
    if (mine === null) notes.push('Your existing listings could not be loaded, so already listed tokens were not skipped.');
    if (!input.all && pick.tokenIds.length < input.count!) {
      lines.push(`Only ${pick.tokenIds.length === 1 ? '1 token qualifies' : `${pick.tokenIds.length} tokens qualify`}, you asked for ${input.count}.`);
      notes.push('Fewer tokens than requested: tell the user before executing.');
    }
  }

  const floors = new Map<string, Promise<PricingFloor>>();
  const floorOf = (contract: string) => {
    const key = contract.toLowerCase();
    let pending = floors.get(key);
    if (!pending) {
      pending = pricingFloor(ctx, chainId, key, refs.used.get(key)?.name ?? '', offMode);
      floors.set(key, pending);
    }
    return pending;
  };
  const shownMath = new Set<string>();
  const items = await Promise.all(raw.map(async (item, i) => {
    if (item.floorPct === undefined) {
      if (item.price === undefined) throw new GuardError(`${hasItems ? `items[${i}]` : 'The listing'} needs price or floorPct. Nothing was signed.`);
      return { contract: item.contract, tokenId: item.tokenId, price: item.price, quantity: item.quantity };
    }
    const pct = assertFloorPct(item.floorPct, hasItems ? `items[${i}].` : '');
    if (typeof item.contract !== 'string' || !ADDRESS_RE.test(item.contract)) throw new GuardError(`items[${i}].contract must be a 0x address.`);
    const floor = await floorOf(item.contract);
    const priceWei = floorPctPrice(floor.wei, pct);
    const math = `${floor.name} price: ${floor.label} ${native(floor.wei, chainId)} x ${pct}% = ${native(priceWei, chainId)}`;
    if (!shownMath.has(math)) {
      shownMath.add(math);
      lines.push(math);
      if (floor.source) lines.push(floor.source);
      if (floor.warning) floorWarnings.push(floor.warning);
    }
    return { contract: item.contract, tokenId: item.tokenId, price: formatUnits(priceWei, 18), quantity: item.quantity };
  }));

  const preview = await previewListing(ctx, {
    chainId,
    items,
    durationDays: input.durationDays,
    crossListOpenSea: input.crossListOpenSea,
    openSeaMarkupBps: input.openSeaMarkupBps,
    allowNoFloor: input.allowNoFloor,
  });
  if (shownMath.size > 0) notes.push('floorPct prices were computed by oswiki-sign from the floor shown on the card.');
  return decorate(preview, [...refs.lines(), ...lines], [...refs.warnings(), ...floorWarnings], notes);
}

export interface OfferAutoInput extends Omit<OfferInput, 'contract'> {
  contract?: string;
  collection?: string;
}

export async function previewOfferAuto(ctx: Ctx, input: OfferAutoInput): Promise<CardPreview<OfferPlan>> {
  const chainId = chainOf(input.chainId);
  assertBuyingEnabled(ctx.config, chainId);
  const refs = new CollectionRefs(ctx, chainId);
  const contract = await refs.contract(input, 'The offer');
  const preview = await previewOffer(ctx, { ...input, contract });
  return decorate(preview, refs.lines(), refs.warnings());
}

export interface AcceptAutoInput {
  chainId: number;
  bidId?: string;
  tokenId: string;
  best?: boolean;
  contract?: string;
  collection?: string;
  allowNoFloor?: boolean;
}

const ACCEPTABLE_KINDS = new Set(['single-token', 'item', 'collection']);

export async function previewAcceptAuto(ctx: Ctx, input: AcceptAutoInput): Promise<CardPreview<AcceptPlan>> {
  if (input.bidId !== undefined) {
    if (input.best !== undefined || input.contract !== undefined || input.collection !== undefined) throw new GuardError('Pass either bidId, or best: true with collection or contract, not both. Nothing was sent.');
    return previewAcceptOffer(ctx, { chainId: input.chainId, bidId: input.bidId, tokenId: input.tokenId, allowNoFloor: input.allowNoFloor });
  }
  const chainId = chainOf(input.chainId);
  if (input.best !== true) throw new GuardError('Pass a bidId, or best: true with collection or contract and tokenId. Nothing was sent.');
  if (typeof input.tokenId !== 'string' || !TOKEN_ID_RE.test(input.tokenId)) throw new GuardError('tokenId must be a decimal token id.');
  const refs = new CollectionRefs(ctx, chainId);
  const contract = (await refs.contract(input, 'The offer')).toLowerCase();
  if (!ADDRESS_RE.test(contract)) throw new GuardError('contract must be a 0x address.');
  assertCollectionAllowed(ctx.config, contract);
  const bids = await ctx.api.bestBids(chainId, contract, input.tokenId);
  const wallet = me(ctx);
  const seen = new Set<string>();
  const chosen = [bids.best, bids.itemOffer, bids.collectionOffer].find((bid) => {
    if (!bid || seen.has(bid.id)) return false;
    seen.add(bid.id);
    return bid.maker !== wallet && bid.contract === contract && ACCEPTABLE_KINDS.has(bid.kind ?? '');
  });
  if (!chosen) {
    const name = refs.used.get(contract)?.name || await ctx.api.collection(chainId, contract).then(info => cleanName(info.name), () => '') || shortHex(contract);
    throw new GuardError(`No active OSWiki offer from another wallet for ${name} #${input.tokenId} on ${chainLabel(chainId)}. Nothing was sent.`);
  }
  const preview = await previewAcceptOffer(ctx, { chainId, bidId: chosen.id, tokenId: input.tokenId, allowNoFloor: input.allowNoFloor });
  if (preview.plan.contract !== contract) throw new GuardError('The best offer is for another collection. Nothing was sent.');
  const kind = chosen.kind === 'collection' ? 'a collection offer' : 'an offer on this token';
  return decorate(preview, [...refs.lines(), `Picked by oswiki-sign: the best OSWiki offer for #${input.tokenId} (${kind}).`], refs.warnings(), [`Best offer picked: ${chosen.id}.`]);
}

export interface CancelAutoInput {
  chainId: number;
  askIds?: string[];
  bidIds?: string[];
  orders?: Array<Record<string, unknown>>;
  all?: boolean;
  collection?: string;
  listings?: boolean;
  offers?: boolean;
}

export async function previewCancelAuto(ctx: Ctx, input: CancelAutoInput): Promise<CardPreview<CancelPlan>> {
  const sweep = input.all === true || input.collection !== undefined;
  if (!sweep) {
    if (input.listings !== undefined || input.offers !== undefined) throw new GuardError('listings and offers go with all: true or collection. Nothing was sent.');
    return previewCancel(ctx, input);
  }
  if (input.all === true && input.collection !== undefined) throw new GuardError('Pass either all: true or collection, not both. Nothing was sent.');
  const chainId = chainOf(input.chainId);
  const wantListings = input.listings !== false;
  const wantOffers = input.offers !== false;
  if (!wantListings && !wantOffers) throw new GuardError('listings and offers are both false: nothing to cancel.');
  const refs = new CollectionRefs(ctx, chainId);
  const collection = input.collection !== undefined ? await refs.resolve(input.collection) : null;
  const wallet = me(ctx);
  const [asks, bids] = await Promise.all([
    wantListings ? ctx.api.makerListings(chainId, wallet) : Promise.resolve([]),
    wantOffers ? ctx.api.allMakerBids(chainId, wallet) : Promise.resolve([]),
  ]);
  const inScope = (contract: string) => collection === null || contract === collection.address;
  const askIds = [...new Set([...(input.askIds ?? []), ...asks.filter(row => inScope(row.contract)).map(row => row.id)])];
  const bidIds = [...new Set([...(input.bidIds ?? []), ...bids.filter(row => inScope(row.contract)).map(row => row.id)])];
  const where = collection ? ` in ${collectionLabel(collection)}` : '';
  const what = [wantListings ? 'listings' : '', wantOffers ? 'offers' : ''].filter(Boolean).join(' or ');
  if (askIds.length + bidIds.length + (input.orders ?? []).length === 0) throw new GuardError(`This wallet has no open OSWiki ${what}${where} on ${chainLabel(chainId)}. Nothing to cancel.`);
  if (askIds.length + bidIds.length + (input.orders ?? []).length > MAX_CANCELS) {
    throw new GuardError(`That is ${askIds.length + bidIds.length} open orders${where}, more than ${MAX_CANCELS} per cancel. Cancel by collection, or listings and offers separately. Nothing was sent.`);
  }
  const preview = await previewCancel(ctx, { chainId, askIds, bidIds, orders: input.orders });
  const notes = asks.length >= 100 ? ['my_listings returns at most 100 listings: run this again afterwards to catch any further ones.'] : [];
  const line = `Collected by oswiki-sign: ${[wantListings ? plural(askIds.length, 'open listing') : '', wantOffers ? plural(bidIds.length, 'open offer') : ''].filter(Boolean).join(' and ')} of this wallet${where}.`;
  return decorate(preview, [...refs.lines(), line], [], notes);
}

export interface TransferAutoInput extends Omit<TransferInput, 'items'> {
  items?: Array<{ contract?: string; collection?: string; tokenId: string; amount?: number }>;
  collections?: Array<{ collection: string; count?: number; all?: boolean }>;
}

export async function previewTransferAuto(ctx: Ctx, input: TransferAutoInput): Promise<{ text: string; plan: TransferPlan }> {
  const chainId = chainOf(input.chainId);
  const refs = new CollectionRefs(ctx, chainId);
  const items = await Promise.all((input.items ?? []).map(async (item, i) => ({ contract: await refs.contract(item, `items[${i}]`), tokenId: item.tokenId, amount: item.amount })));
  const lines: string[] = [];
  for (const entry of input.collections ?? []) {
    const collection = await refs.resolve(entry.collection);
    const taken = new Set(items.filter(item => item.contract.toLowerCase() === collection.address).map(item => item.tokenId));
    const room = MAX_TRANSFER_ITEMS - items.length;
    if (room <= 0) throw new GuardError(`Send at most ${MAX_TRANSFER_ITEMS} NFTs at once. Nothing was sent.`);
    const pick = await pickOwnedTokens(ctx, chainId, collection, { count: entry.count, all: entry.all, max: room, skip: taken });
    for (const tokenId of pick.tokenIds) items.push({ contract: collection.address, tokenId, amount: undefined });
    lines.push(`Picked by oswiki-sign: ${entry.all ? 'all ' : ''}${plural(pick.tokenIds.length, 'token')} of your ${collectionLabel(collection)}: ${pick.tokenIds.map(id => `#${id}`).join(', ')}.`);
  }
  const preview = await previewTransfer(ctx, { chainId, to: input.to, items: items.map(({ amount, ...item }) => (amount === undefined ? item : { ...item, amount })), nativeAmount: input.nativeAmount, wrappedAmount: input.wrappedAmount });
  return decorate(preview, [...refs.lines(), ...lines], refs.warnings());
}
