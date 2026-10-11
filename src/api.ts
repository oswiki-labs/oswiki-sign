import { API_BASE, ZERO_ADDRESS } from './constants.js';
import type { SeaportRequirements } from './seaport/listing.js';
import type { AcceptOfferData, OfferRequirements } from './seaport/offer.js';
import type { SeaportOrderParameters } from './seaport/order.js';

export class ApiError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number | null) {
    super(message);
    this.name = 'ApiError';
  }
}

const UNSAFE_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]+/gu;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** Server text reaches the AI and the confirmation dialog: control, format (bidi) and line/paragraph separators go, and it is cut short. */
export function sanitizeServerText(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(UNSAFE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** RPC and viem errors can carry URLs, request bodies and attacker-chosen revert strings: first line only, no URLs, short. */
export function sanitizeErrorText(err: unknown, max = 200): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null;
  const raw = typeof e?.shortMessage === 'string' && e.shortMessage ? e.shortMessage : typeof e?.message === 'string' ? e.message : '';
  const firstLine = raw.split(/\r?\n|\u2028|\u2029/)[0] ?? '';
  return sanitizeServerText(firstLine.replace(URL_RE, '[url]'), max) || 'RPC error';
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_ID_RE = /^(0|[1-9][0-9]{0,77})$/;
const ORDER_ID_RE = /^oswiki-0x[0-9a-fA-F]{64}$/;
const SYMBOL_RE = /^[A-Za-z]{2,6}$/;
const WORD_RE = /^[a-z][a-z_-]{0,29}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

export function cleanAddress(value: unknown): string | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value.toLowerCase() : null;
}

export function cleanTokenId(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof text === 'string' && DECIMAL_ID_RE.test(text) ? text : null;
}

export function cleanOrderId(value: unknown): string | null {
  return typeof value === 'string' && ORDER_ID_RE.test(value) ? `oswiki-${value.slice(7).toLowerCase()}` : null;
}

/** Empty stays empty (the chain's own currency); anything but a plain symbol becomes "?". */
export function cleanSymbol(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' && SYMBOL_RE.test(value) ? value.toUpperCase() : '?';
}

export function cleanWord(value: unknown): string {
  return typeof value === 'string' && WORD_RE.test(value) ? value : '';
}

function uintOrNull(value: unknown): bigint | null {
  return typeof value === 'string' && UINT_RE.test(value) ? BigInt(value) : null;
}

export interface SignedOrderPayload {
  parameters: SeaportOrderParameters;
  signature: string;
  orderHash?: string;
}

export interface BatchResult {
  results: Array<{ success?: boolean; askId?: string; bidId?: string; message?: string; code?: string; tokenId?: string; contractAddress?: string }>;
  created: number;
  failed: number;
}

export interface OrderComponentsResponse {
  components: Record<string, unknown> | null;
  orderHash: string | null;
  twin: { orderHash?: unknown; parameters?: unknown; status?: unknown } | null;
}

export interface MarketOrder {
  id: string;
  chainId: number;
  contract: string;
  tokenId: string | null;
  maker: string;
  price: number | null;
  priceWei?: bigint | null;
  kind?: string;
  expiresAt?: unknown;
}

export interface CrossListingResult {
  status: string;
  orderHash: string | null;
}

export interface TokenReference {
  tokenId: string;
  owner: string | null;
  lastSale: { price: number; currency: string; timestamp: string | null } | null;
  attributes: Array<{ traitType: string; value: string }>;
}

export interface SaleReference {
  tokenId: string;
  price: number;
  currency: string;
  timestamp: string | null;
}

export interface CollectionInfo {
  address: string;
  name: string;
  slug: string;
  contractType: string | null;
  floorPrice: number | null;
  currency: string | null;
  royalty: { bps: number; recipient: string } | null;
  verified?: boolean | null;
}

export interface EnsLookup {
  address: string | null;
  apechainAddress: string | null;
  reverseName: string | null;
}

export interface VerifiedCollection {
  address: string;
  name: string;
}

const VERIFIED_CACHE_MS = 30 * 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every /v1 shape the signer depends on lives here. The signer never trusts these
 * responses for safety: orders are rebuilt and checked locally against the chain.
 */
export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly verifiedCache = new Map<number, { at: number; rows: Promise<VerifiedCollection[]> }>();

  constructor(private readonly options: { apiKey: string | null; base?: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async orderParams(chainId: number): Promise<{ minUnitPriceWei: bigint | null }> {
    const data = asRecord(await this.request('GET', '/v1/orders/params', { chainId }));
    const raw = asRecord(data?.bounds)?.minUnitPriceWei;
    return { minUnitPriceWei: typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : typeof raw === 'number' && Number.isSafeInteger(raw) ? BigInt(raw) : null };
  }

  async listingRequirements(input: { chainId: number; maker: string; items: Array<{ contract: string; tokenId: string; quantity: number; unitPriceWei: string }> }): Promise<SeaportRequirements> {
    return await this.request('POST', '/v1/listings/requirements', undefined, input) as SeaportRequirements;
  }

  async offerRequirements(input: { chainId: number; maker: string; items: Array<{ kind: string; contract: string; tokenId: string | null; amountWei: string; quantity: number }> }): Promise<OfferRequirements> {
    return await this.request('POST', '/v1/bids/requirements', undefined, input) as OfferRequirements;
  }

  async createAsk(chainId: number, seaport: SignedOrderPayload, opensea?: SignedOrderPayload | null): Promise<{ askId: string | null; crossListing: CrossListingResult | null }> {
    const data = asRecord(await this.request('POST', '/v1/orders/asks', undefined, opensea ? { chainId, seaport, opensea } : { chainId, seaport }));
    const cross = asRecord(data?.crossListing);
    return {
      askId: cleanOrderId(data?.askId),
      crossListing: cross
        ? { status: cleanWord(cross.status) || 'unknown', orderHash: typeof cross.orderHash === 'string' && HASH_RE.test(cross.orderHash) ? cross.orderHash.toLowerCase() : null }
        : null,
    };
  }

  async createAsksBulk(chainId: number, listings: Array<{ seaport: SignedOrderPayload; opensea?: SignedOrderPayload }>): Promise<BatchResult> {
    return this.batch(await this.request('POST', '/v1/orders/asks/bulk', undefined, { chainId, listings }, true));
  }

  async createBid(chainId: number, seaport: SignedOrderPayload): Promise<{ bidId: string | null }> {
    const data = asRecord(await this.request('POST', '/v1/orders/bids', undefined, { chainId, seaport }));
    return { bidId: cleanOrderId(data?.bidId) };
  }

  async createBidsBulk(chainId: number, offers: Array<{ seaport: SignedOrderPayload }>): Promise<BatchResult> {
    return this.batch(await this.request('POST', '/v1/orders/bids/bulk', undefined, { chainId, offers }, true));
  }

  /** OpenSea fills are authorized for the buyer, so the wallet always goes along; maxPriceWei makes the server refuse a dearer order. */
  async buyData(chainId: number, askId: string, buyer: string, maxPriceWei?: bigint): Promise<unknown> {
    const body: Record<string, unknown> = { chainId, buyer };
    if (maxPriceWei !== undefined) body.maxPriceWei = maxPriceWei.toString();
    return this.request('POST', `/v1/listings/${encodeURIComponent(askId)}/buy-data`, undefined, body);
  }

  async listing(chainId: number, askId: string): Promise<{ contract: string; tokenId: string; maker: string; status: string | null }> {
    const data = asRecord(await this.request('GET', `/v1/listings/${encodeURIComponent(askId)}`, { chainId }));
    const contract = asRecord(data?.contract)?.address;
    const tokenId = data?.tokenId;
    return {
      contract: contract === undefined || contract === null || contract === '' ? '' : cleanAddress(contract) ?? 'invalid',
      tokenId: tokenId === undefined || tokenId === null || tokenId === '' ? '' : cleanTokenId(tokenId) ?? 'invalid',
      maker: cleanAddress(data?.maker) ?? '',
      status: cleanWord(data?.status) || null,
    };
  }

  async bid(chainId: number, bidId: string): Promise<{ contract: string; tokenId: string | null; maker: string; kind: string; status: string | null }> {
    const data = asRecord(await this.request('GET', `/v1/bids/${encodeURIComponent(bidId)}`, { chainId }));
    return {
      contract: cleanAddress(asRecord(data?.contract)?.address) ?? '',
      tokenId: cleanTokenId(data?.tokenId),
      maker: cleanAddress(data?.maker) ?? '',
      kind: cleanWord(data?.kind),
      status: cleanWord(data?.status) || null,
    };
  }

  async acceptData(chainId: number, bidId: string, fulfiller: string, tokenId: string): Promise<AcceptOfferData> {
    return await this.request('POST', `/v1/bids/${encodeURIComponent(bidId)}/accept-data`, undefined, { chainId, fulfiller, tokenId }) as AcceptOfferData;
  }

  async askComponents(chainId: number, askId: string): Promise<OrderComponentsResponse> {
    return this.components(await this.request('GET', `/v1/orders/asks/${encodeURIComponent(askId)}/components`, { chainId }));
  }

  async bidComponents(chainId: number, bidId: string): Promise<OrderComponentsResponse> {
    return this.components(await this.request('GET', `/v1/orders/bids/${encodeURIComponent(bidId)}/components`, { chainId }));
  }

  /** Filtered by maker locally too, in case the server ignores the filter. */
  async makerListings(chainId: number, maker: string): Promise<MarketOrder[]> {
    const rows = await this.request('GET', '/v1/listings', { chainId, maker, status: 'active', per_page: 100 });
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const r = asRecord(row) ?? {};
      return {
        id: cleanOrderId(r.askId) ?? '',
        chainId,
        contract: cleanAddress(asRecord(r.contract)?.address) ?? '',
        tokenId: cleanTokenId(r.tokenId),
        maker: cleanAddress(r.maker) ?? '',
        price: finiteOrNull(asRecord(asRecord(r.price)?.amount)?.decimal ?? r.price),
        expiresAt: r.expiresAt,
      };
    }).filter(row => row.id !== '' && row.contract !== '' && row.maker === maker.toLowerCase());
  }

  async makerBids(chainId: number, maker: string, page = 1): Promise<MarketOrder[]> {
    const query: Record<string, string | number> = { chainId, maker, status: 'active', per_page: 100 };
    if (page > 1) query.page = page;
    const rows = await this.request('GET', '/v1/bids', query);
    return (Array.isArray(rows) ? rows : []).map((row) => {
      const r = asRecord(row) ?? {};
      return {
        id: cleanOrderId(r.bidId) ?? '',
        chainId,
        contract: cleanAddress(asRecord(r.contract)?.address) ?? '',
        tokenId: cleanTokenId(r.tokenId),
        maker: cleanAddress(r.maker) ?? '',
        price: finiteOrNull(r.price),
        priceWei: uintOrNull(r.priceWei),
        kind: cleanWord(r.kind),
        expiresAt: r.expiresAt,
      };
    }).filter(row => row.id !== '' && row.contract !== '' && row.maker === maker.toLowerCase());
  }

  /** Every active OSWiki offer of the maker, all pages; throws past `maxPages`. */
  async allMakerBids(chainId: number, maker: string, maxPages = 20): Promise<MarketOrder[]> {
    const all = new Map<string, MarketOrder>();
    for (let page = 1; page <= maxPages; page++) {
      const rows = await this.makerBids(chainId, maker, page);
      for (const row of rows) all.set(row.id, row);
      if (rows.length < 100) return [...all.values()];
    }
    throw new ApiError('Too many open offers to add up.', null, null);
  }

  /** Cheapest active OSWiki listing price of the collection, as the API reports it. */
  async cheapestListing(chainId: number, slug: string, contract: string): Promise<number | null> {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(slug)) return null;
    const rows = await this.request('GET', '/v1/listings', { chainId, collection: slug, status: 'active', marketplace: 'all', sort: 'price_asc', per_page: 10 });
    const wanted = contract.toLowerCase();
    const prices = (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const r = asRecord(row) ?? {};
      if (cleanAddress(asRecord(r.contract)?.address) !== wanted) return [];
      const price = finiteOrNull(asRecord(asRecord(r.price)?.amount)?.decimal);
      return price !== null && price > 0 ? [price] : [];
    });
    return prices.length > 0 ? Math.min(...prices) : null;
  }

  async collection(chainId: number, address: string): Promise<CollectionInfo> {
    const data = asRecord(await this.request('GET', `/v1/collections/${address.toLowerCase()}`, { chainId })) ?? {};
    const stats = asRecord(data.stats);
    const royalty = asRecord(data.royalty);
    const royaltyRecipient = cleanAddress(royalty?.recipient);
    const royaltyBps = royalty?.bps;
    return {
      address: cleanAddress(data.address) ?? address.toLowerCase(),
      name: sanitizeServerText(data.name, 80),
      slug: sanitizeServerText(data.slug, 80),
      contractType: cleanWord(typeof data.contractType === 'string' ? data.contractType.toLowerCase() : null) || null,
      floorPrice: finiteOrNull(stats?.floorPrice),
      currency: cleanSymbol(stats?.currency) || null,
      royalty: royaltyRecipient && typeof royaltyBps === 'number' && Number.isInteger(royaltyBps) && royaltyBps >= 0 && royaltyBps <= 10000
        ? { bps: royaltyBps, recipient: royaltyRecipient }
        : null,
      verified: typeof data.verified === 'boolean' ? data.verified : null,
    };
  }

  async ensResolve(name: string, chainId: number): Promise<EnsLookup> {
    const data = asRecord(await this.request('GET', '/v1/ens/resolve', { name, chainId }));
    const address = cleanAddress(data?.address);
    const apechainAddress = cleanAddress(data?.apechainAddress);
    if (!data || (data.address !== null && address === null) || (data.apechainAddress != null && apechainAddress === null)) {
      throw new ApiError('OSWiki API /v1/ens/resolve returned an unreadable answer.', null, null);
    }
    const set = (value: string | null) => (value === ZERO_ADDRESS ? null : value);
    return { address: set(address), apechainAddress: set(apechainAddress), reverseName: typeof data.reverseName === 'string' ? sanitizeServerText(data.reverseName, 100) || null : null };
  }

  /** Top verified collections of the chain by volume, cached per client; a failed load is not cached. */
  async verifiedCollections(chainId: number, now: number = Date.now()): Promise<VerifiedCollection[]> {
    const hit = this.verifiedCache.get(chainId);
    if (hit && now - hit.at < VERIFIED_CACHE_MS) return hit.rows;
    const rows = this.request('GET', '/v1/collections', { chainId, verified: 'true', sort: 'volume', period: '30d', per_page: 100 }).then(raw => (Array.isArray(raw) ? raw : []).flatMap((row) => {
      const r = asRecord(row) ?? {};
      const address = cleanAddress(r.address);
      const name = sanitizeServerText(r.name, 80);
      return address && name && r.verified !== false ? [{ address, name }] : [];
    }));
    this.verifiedCache.set(chainId, { at: now, rows });
    rows.catch(() => {
      if (this.verifiedCache.get(chainId)?.rows === rows) this.verifiedCache.delete(chainId);
    });
    return rows;
  }

  async tokens(chainId: number, address: string, tokenIds: string[]): Promise<TokenReference[]> {
    const rows = await this.request('GET', `/v1/collections/${address.toLowerCase()}/tokens`, { chainId, token_ids: tokenIds.join(','), per_page: tokenIds.length });
    const wanted = address.toLowerCase();
    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const r = asRecord(row) ?? {};
      const contract = asRecord(r.contract)?.address;
      if (typeof contract === 'string' && contract.toLowerCase() !== wanted) return [];
      const tokenId = cleanTokenId(r.tokenId);
      if (tokenId === null) return [];
      const sale = asRecord(r.lastSale);
      const salePrice = finiteOrNull(sale?.price);
      return [{
        tokenId,
        owner: cleanAddress(r.owner),
        lastSale: sale && salePrice !== null && salePrice > 0
          ? { price: salePrice, currency: cleanSymbol(sale.currency), timestamp: typeof sale.timestamp === 'string' ? sale.timestamp : null }
          : null,
        attributes: (Array.isArray(r.attributes) ? r.attributes : []).flatMap((entry) => {
          const a = asRecord(entry);
          if (!a || typeof a.traitType !== 'string' || a.value === null || a.value === undefined || typeof a.value === 'object') return [];
          const traitType = sanitizeServerText(a.traitType, 60).replace(/["`]/g, '\'');
          const value = sanitizeServerText(String(a.value), 60).replace(/["`]/g, '\'');
          return traitType && value ? [{ traitType, value }] : [];
        }),
      }];
    });
  }

  /** `traits` maps trait type to value (up to 5, all must match). */
  async sales(chainId: number, address: string, traits: Record<string, string> = {}, perPage = 50): Promise<SaleReference[]> {
    const query: Record<string, string | number> = { chainId, collection: address.toLowerCase(), per_page: perPage };
    for (const [type, value] of Object.entries(traits).slice(0, 5)) query[`traits[${type}]`] = value;
    const rows = await this.request('GET', '/v1/sales', query);
    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const r = asRecord(row) ?? {};
      const price = asRecord(r.price);
      const amount = finiteOrNull(price?.amount);
      if (amount === null || amount <= 0) return [];
      const tokenId = cleanTokenId(r.tokenId);
      if (tokenId === null) return [];
      return [{ tokenId, price: amount, currency: cleanSymbol(price?.currency), timestamp: typeof r.timestamp === 'string' ? r.timestamp : null }];
    });
  }

  private components(raw: unknown): OrderComponentsResponse {
    const data = asRecord(raw) ?? {};
    const components = asRecord(data.parameters);
    const twinRaw = asRecord(data.opensea);
    const twin = twinRaw ? { orderHash: twinRaw.orderHash, parameters: twinRaw.parameters, status: twinRaw.status } : null;
    return { components, orderHash: typeof data.orderHash === 'string' ? data.orderHash : null, twin };
  }

  private batch(raw: unknown): BatchResult {
    const data = asRecord(raw) ?? {};
    const results = Array.isArray(data.results) ? data.results.map(entry => asRecord(entry) ?? {}) : [];
    return {
      results: results.map(entry => ({
        success: entry.success === true,
        askId: cleanOrderId(entry.askId) ?? undefined,
        bidId: cleanOrderId(entry.bidId) ?? undefined,
        message: sanitizeServerText(entry.message),
        code: typeof entry.code === 'string' ? sanitizeServerText(entry.code, 40) : undefined,
        tokenId: cleanTokenId(entry.tokenId) ?? undefined,
        contractAddress: cleanAddress(entry.contractAddress) ?? undefined,
      })),
      created: typeof data.created === 'number' ? data.created : 0,
      failed: typeof data.failed === 'number' ? data.failed : 0,
    };
  }

  private async request(method: 'GET' | 'POST', path: string, query?: Record<string, string | number>, body?: unknown, partialBatch = false): Promise<unknown> {
    const url = new URL(path, this.options.base ?? API_BASE);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.apiKey) headers['X-API-Key'] = this.options.apiKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch {
      throw new ApiError(`Could not reach the OSWiki API (${path}).`, null, null);
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    const envelope = asRecord(json);
    if (partialBatch && envelope && Array.isArray(asRecord(envelope.data)?.results)) return envelope.data;
    if (!response.ok || !envelope || envelope.success === false) {
      const message = sanitizeServerText(envelope?.message ?? envelope?.error) || `HTTP ${response.status}`;
      const code = typeof envelope?.code === 'string' ? sanitizeServerText(envelope.code, 40) : null;
      throw new ApiError(`OSWiki API ${path} failed: ${message}${code ? ` (${code})` : ''}`, code, response.status);
    }
    return envelope.data;
  }
}
