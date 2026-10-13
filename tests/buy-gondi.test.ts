import { decodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { FULFILL_ADVANCED_ORDER_ABI, FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, WRAPPED_NATIVE_ABI, type SeaportAdvancedOrder } from '../src/abi.js';
import type { CollectionListing } from '../src/api.js';
import { GONDI_FEE_RECIPIENT, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_ADDRESS } from '../src/constants.js';
import { BUY_ASK_ID_RE, marketplaceOf } from '../src/flows/buy.js';
import { isBuyableRow } from '../src/flows/references.js';
import { orderHashFromAskId, readAdvancedOrder } from '../src/seaport/fulfill.js';
import { assertGondiSeaportOrder, GondiOrderGuardError, type GondiBuyData } from '../src/seaport/gondi-buy.js';
import { hashOrderComponents, verifySeaportOrderSignature } from '../src/seaport/sign.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { boughtLog, COLLECTION, confirmIdOf, ETH, flat, harness, OTHER_SELLER, ROYALTY_RECIPIENT, TEST_ADDRESS, type Harness } from './helpers.js';

const NOW_SECONDS = BigInt(Date.parse('2026-10-10T12:00:00Z') / 1000);
const WETH = WRAPPED_NATIVE[1]!.toLowerCase();
const BAYC = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const REAL_MAKER = '0x1bb35a7c55e90188e3cf31034c80a884c1edd922' as Address;
const REAL_HASH = '0xffef3a7f0c2dbac528884bfe774680a09c8f14f9c47f3ea1605f59150e3e8122';
const REAL_SIGNATURE = '0x981c0faab3a08662b5c1e08239111c43aaff24422cb0af1a5a0f01d9cd9c5a274833d9e0bf2818fdfc107d416fffe0708944ffe7d84d8454d6ea6313fcc1d0461c';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const ZERO32 = `0x${'0'.repeat(64)}`;

interface Leg { itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string }
interface Params {
  offerer: string;
  zone: string;
  offer: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string }>;
  consideration: Leg[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: number;
}

const leg = (amount: bigint, recipient: string, token: string = ZERO_ADDRESS): Leg => ({
  itemType: token === ZERO_ADDRESS ? 0 : 1,
  token,
  identifierOrCriteria: '0',
  startAmount: amount.toString(),
  endAmount: amount.toString(),
  recipient,
});

/** Gondi order 13073907979 (BAYC #6057), as the backend pins it: Gondi verified its hash against Seaport.getOrderHash. */
function realGondi(): Params {
  return {
    offerer: REAL_MAKER,
    zone: ZERO_ADDRESS,
    offer: [{ itemType: 2, token: BAYC, identifierOrCriteria: '6057', startAmount: '1', endAmount: '1' }],
    consideration: [leg(10945000000000000000n, REAL_MAKER), leg(55000000000000000n, GONDI_FEE_RECIPIENT)],
    orderType: 0,
    startTime: '1790236678',
    endTime: '1792828678',
    zoneHash: ZERO32,
    salt: '0',
    conduitKey: ZERO32,
    totalOriginalConsiderationItems: 2,
  };
}

function gondiListing(options: { tokenId?: string; price?: bigint; token?: string; extra?: Leg[] } = {}): Params {
  const price = options.price ?? ETH;
  const token = options.token ?? ZERO_ADDRESS;
  const fee = (price * 50n) / 10000n;
  const extra = options.extra ?? [];
  const extraWei = extra.reduce((sum, entry) => sum + BigInt(entry.startAmount), 0n);
  return {
    offerer: OTHER_SELLER,
    zone: ZERO_ADDRESS,
    offer: [{ itemType: 2, token: COLLECTION, identifierOrCriteria: options.tokenId ?? '7', startAmount: '1', endAmount: '1' }],
    consideration: [leg(price - fee - extraWei, OTHER_SELLER, token), leg(fee, GONDI_FEE_RECIPIENT, token), ...extra],
    orderType: 0,
    startTime: String(NOW_SECONDS - 3600n),
    endTime: String(NOW_SECONDS + 86400n * 30n),
    zoneHash: ZERO32,
    salt: '12345',
    conduitKey: ZERO32,
    totalOriginalConsiderationItems: 2 + extra.length,
  };
}

function toOrder(params: Params, signature = SIGNATURE): SeaportAdvancedOrder {
  return readAdvancedOrder({ parameters: params, signature }, (reason) => {
    throw new Error(reason);
  });
}

function hashOf(params: Params, counter = 0n): Hex {
  const { totalOriginalConsiderationItems: _total, ...components } = toOrder(params).parameters;
  return hashOrderComponents({ ...components, counter });
}

function buyData(params: Params, options: { wallet?: Address; signature?: string } = {}): GondiBuyData & { orderData: Record<string, unknown> } {
  const total = params.consideration.reduce((sum, c) => sum + BigInt(c.startAmount), 0n);
  const wrappedOrder = params.consideration[0]!.itemType === 1;
  return {
    askId: `gondi-${hashOf(params)}`,
    marketplace: 'gondi',
    to: SEAPORT_ADDRESS,
    value: wrappedOrder ? '0' : total.toString(),
    priceWei: total.toString(),
    currency: { symbol: wrappedOrder ? 'WETH' : 'ETH', address: wrappedOrder ? WETH : ZERO_ADDRESS, decimals: 18 },
    orderData: {
      parameters: params,
      signature: options.signature ?? SIGNATURE,
      numerator: 1,
      denominator: 1,
      extraData: '0x',
      fulfillerConduitKey: ZERO32,
      recipient: options.wallet ?? TEST_ADDRESS,
    },
    expectedItem: { contract: params.offer[0]!.token, tokenId: params.offer[0]!.identifierOrCriteria, amount: '1', itemType: params.offer[0]!.itemType },
  };
}

const expectFor = (params: Params) => ({ chainId: 1, contract: params.offer[0]!.token, tokenId: params.offer[0]!.identifierOrCriteria, wallet: TEST_ADDRESS, nowSeconds: NOW_SECONDS });

describe('Gondi askIds', () => {
  it('parses gondi- ids and never treats an unknown prefix as OpenSea', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    expect(BUY_ASK_ID_RE.test(`gondi-${hash}`)).toBe(true);
    expect(BUY_ASK_ID_RE.test(`blur-${hash}`)).toBe(false);
    expect(marketplaceOf(`gondi-${hash}`)).toBe('gondi');
    expect(marketplaceOf(`oswiki-${hash}`)).toBe('oswiki');
    expect(marketplaceOf(hash)).toBe('opensea');
    expect(() => marketplaceOf(`blur-${hash}`)).toThrow(/cannot buy from/);
    expect(orderHashFromAskId(`gondi-${hash}`)).toBe(hash);
  });

  it('counts Gondi rows as buyable in ETH or WETH, refuses unknown or mismatched marketplaces', () => {
    const row = (overrides: Partial<CollectionListing>): CollectionListing => ({ askId: `gondi-0x${'ab'.repeat(32)}`, contract: COLLECTION, tokenId: '1', maker: OTHER_SELLER, price: 1, marketplace: 'gondi', buyable: true, currencyContract: ZERO_ADDRESS, ...overrides });
    expect(isBuyableRow(row({}), 1)).toBe(true);
    expect(isBuyableRow(row({ currencyContract: null }), 1)).toBe(true);
    expect(isBuyableRow(row({ currencyContract: WETH }), 1)).toBe(true);
    expect(isBuyableRow(row({ currencyContract: '0x1111111111111111111111111111111111111111' }), 1)).toBe(false);
    expect(isBuyableRow(row({ marketplace: 'opensea' }), 1)).toBe(false);
    expect(isBuyableRow(row({ askId: `0x${'ab'.repeat(32)}` }), 1)).toBe(false);
    expect(isBuyableRow(row({ askId: `blur-0x${'ab'.repeat(32)}`, marketplace: 'blur' }), 1)).toBe(false);
    expect(isBuyableRow(row({ buyable: false }), 1)).toBe(false);
    expect(isBuyableRow(row({ askId: `oswiki-0x${'ab'.repeat(32)}`, marketplace: 'oswiki', currencyContract: WETH }), 1)).toBe(false);
  });
});

describe('Gondi buy guard', () => {
  it('accepts the real Gondi order: its struct hash and signature match Gondi\'s', async () => {
    const params = realGondi();
    expect(hashOf(params)).toBe(REAL_HASH);
    const guarded = assertGondiSeaportOrder(buyData(params, { signature: REAL_SIGNATURE }), expectFor(params));
    expect(guarded.value).toBe(11n * ETH);
    expect(guarded.currency).toBe('native');
    expect(guarded.gondiFeeWei).toBe(55000000000000000n);
    expect(guarded.sellerWei).toBe(10945000000000000000n);
    expect(guarded.otherFeesWei).toBe(0n);
    expect(await verifySeaportOrderSignature({ chainId: 1, offerer: REAL_MAKER, orderHash: REAL_HASH, signature: REAL_SIGNATURE })).toBe(true);
  });

  it('accepts a WETH order with value 0 and up to two more legs in the same currency', () => {
    const params = gondiListing({ token: WETH, extra: [leg(ETH / 20n, ROYALTY_RECIPIENT, WETH)] });
    const guarded = assertGondiSeaportOrder(buyData(params), expectFor(params));
    expect(guarded.value).toBe(0n);
    expect(guarded.costWei).toBe(ETH);
    expect(guarded.currency).toBe('wrapped');
    expect(guarded.otherFeesWei).toBe(ETH / 20n);
  });

  const rejects = (params: Params, reason: RegExp, change: (data: ReturnType<typeof buyData>) => unknown = data => data) => {
    expect(() => assertGondiSeaportOrder(change(buyData(params)) as GondiBuyData, expectFor(gondiListing()))).toThrow(GondiOrderGuardError);
    expect(() => assertGondiSeaportOrder(change(buyData(params)) as GondiBuyData, expectFor(gondiListing()))).toThrow(reason);
  };

  it('refuses a conduit, a zone or a zone hash', () => {
    rejects({ ...gondiListing(), conduitKey: vectors.orders.erc721.parameters.conduitKey }, /conduitKey must be 0/);
    rejects({ ...gondiListing(), zone: '0x000056f7000000ece9003ca63978907a00ffd100' }, /zone must be 0/);
    rejects({ ...gondiListing(), zoneHash: `0x${'11'.repeat(32)}` }, /zone must be 0/);
  });

  it('refuses another token or collection than the listing', () => {
    rejects(gondiListing({ tokenId: '8' }), /expected NFT/);
    const other = gondiListing();
    other.offer[0]!.token = '0x2222222222222222222222222222222222222222';
    rejects(other, /expected collection/);
  });

  it('refuses royalty-shaped extra legs in another currency, and too many legs', () => {
    rejects(gondiListing({ extra: [leg(ETH / 20n, ROYALTY_RECIPIENT, WETH)] }), /one currency/);
    rejects(gondiListing({ token: WETH, extra: [leg(ETH / 20n, ROYALTY_RECIPIENT)] }), /one currency/);
    rejects(gondiListing({ extra: [leg(1n, ROYALTY_RECIPIENT, '0x1111111111111111111111111111111111111111')] }), /one currency/);
    const many = ['0x1000000000000000000000000000000000000001', '0x1000000000000000000000000000000000000002', '0x1000000000000000000000000000000000000003'];
    rejects(gondiListing({ extra: many.map(recipient => leg(1n, recipient)) }), /at most two more fees/);
  });

  it('refuses a missing, foreign or wrong-sized Gondi fee and a seller that is not paid first', () => {
    const noFee = gondiListing();
    noFee.consideration[1]!.recipient = ROYALTY_RECIPIENT;
    rejects(noFee, /Gondi fee payment is missing/);
    const wrongFee = gondiListing();
    wrongFee.consideration[1] = leg(ETH / 100n, GONDI_FEE_RECIPIENT);
    rejects(wrongFee, /must be 0.5% of the price/);
    const swapped = gondiListing();
    swapped.consideration.reverse();
    rejects(swapped, /seller/);
  });

  it('refuses expired and not yet active orders', () => {
    rejects({ ...gondiListing(), endTime: String(NOW_SECONDS) }, /expired/);
    rejects({ ...gondiListing(), startTime: String(NOW_SECONDS + 60n) }, /not active yet/);
  });

  it('refuses a wrong value, a non-65-byte signature, another recipient, foreign calldata and other marketplaces', () => {
    rejects(gondiListing(), /exact order total/, data => ({ ...data, value: '1' }));
    rejects(gondiListing({ token: WETH }), /takes no value/, data => ({ ...data, value: ETH.toString() }));
    rejects(gondiListing(), /65 bytes/, data => ({ ...data, orderData: { ...data.orderData, signature: `0x${'ab'.repeat(64)}` } }));
    rejects(gondiListing(), /would not go to this wallet/, data => ({ ...data, orderData: { ...data.orderData, recipient: OTHER_SELLER } }));
    rejects(gondiListing(), /server calldata/, data => ({ ...data, data: '0x1234' }));
    rejects(gondiListing(), /currency does not match/, data => ({ ...data, currency: { address: WETH } }));
    rejects(gondiListing(), /expectedItem/, data => ({ ...data, expectedItem: undefined }));
    rejects(gondiListing(), /not served as a Gondi listing/, data => ({ ...data, marketplace: 'opensea' }));
    rejects(gondiListing(), /not Seaport 1.6/, data => ({ ...data, to: ZERO_ADDRESS }));
  });
});

function setupGondi(h: Harness, params: Params, change: (data: ReturnType<typeof buyData>) => unknown = data => data): string {
  const askId = `gondi-${hashOf(params)}`;
  h.api.routes.set(`POST /v1/listings/${askId}/buy-data`, () => change(buyData(params)));
  h.api.routes.set(`GET /v1/listings/${askId}`, () => ({ contract: { address: params.offer[0]!.token }, tokenId: params.offer[0]!.identifierOrCriteria, maker: params.offerer, status: 'active', marketplace: 'gondi' }));
  return askId;
}

describe('preview_buy + execute for Gondi listings', () => {
  it('shows Gondi, the price and the Gondi fee, then sends exactly the order total to Seaport', async () => {
    const params = gondiListing();
    const h = harness({ logsFor: () => [boughtLog(hashOf(params), OTHER_SELLER, { token: COLLECTION, identifier: 7n, amount: 1n }, ETH)] });
    const askId = setupGondi(h, params);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.text).toContain('Gondi · ');
    expect(preview.text).toMatch(/Gondi fee 0\.5% +0\.005 ETH/);
    expect(preview.text).toMatch(/Seller receives +0\.995 ETH/);
    expect(preview.text).toMatch(/\nTotal +1 ETH\n/);
    expect(preview.text).toContain('Simulated just now');
    expect(flat(preview.text)).toContain(`- ${askId}: `);
    expect(flat(preview.text)).toContain('for 1 ETH on Gondi (Gondi fee 0.005 ETH, seller receives 0.995 ETH)');
    expect(preview.text).toContain('Buying 1 Gondi listing for');

    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(`${askId}: bought`);
    expect(h.chain.sent).toHaveLength(1);
    const tx = h.chain.sent[0]!;
    expect(tx.to).toBe(SEAPORT_ADDRESS);
    expect(tx.value).toBe(ETH);
    const decoded = decodeFunctionData({ abi: FULFILL_ADVANCED_ORDER_ABI, data: tx.data.slice(0, -8) as Hex });
    expect((decoded.args[0] as SeaportAdvancedOrder).parameters.conduitKey).toBe(ZERO32);
    expect((decoded.args[3] as string).toLowerCase()).toBe(TEST_ADDRESS);
  });

  it('keeps the per-trade limit for Gondi listings', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '0.5' } });
    const askId = setupGondi(h, gondiListing());
    expect((await h.call('preview_buy', { chainId: 1, askIds: [askId] })).text).toMatch(/above the per-trade limit of 0\.5 ETH/);
  });

  it('refuses order data that does not hash to the gondi- askId, or is served as another marketplace', async () => {
    const h = harness();
    const params = gondiListing();
    const askId = setupGondi(h, params);
    h.chain.counters.set(OTHER_SELLER, 1n);
    expect((await h.call('preview_buy', { chainId: 1, askIds: [askId] })).text).toMatch(/does not hash/);
    const h2 = harness();
    const askId2 = setupGondi(h2, params, data => ({ ...data, marketplace: 'opensea' }));
    expect((await h2.call('preview_buy', { chainId: 1, askIds: [askId2] })).text).toMatch(/Gondi order rejected: not served as a Gondi listing/);
    expect(h2.chain.sent).toHaveLength(0);
  });

  it('refuses an unknown marketplace prefix before calling the API', async () => {
    const h = harness();
    const result = await h.call('preview_buy', { chainId: 1, askIds: [`blur-0x${'ab'.repeat(32)}`] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Gondi listings \("gondi-0x\.\.\."\)/);
    expect(h.api.requests).toHaveLength(0);
  });

  it('buys a WETH listing: approves exactly the price to Seaport, simulates, then sends with value 0', async () => {
    const params = gondiListing({ token: WETH });
    const h = harness({ logsFor: () => [boughtLog(hashOf(params), OTHER_SELLER, { token: COLLECTION, identifier: 7n, amount: 1n }, ETH)] });
    h.chain.wrappedBalance = 3n * ETH;
    const askId = setupGondi(h, params);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.text).toMatch(/\nTotal +1 WETH\n/);
    expect(preview.text).toMatch(/Approve \(1 transaction\) +1 WETH/);
    expect(flat(preview.text)).toContain('simulated right before sending, after the approval');
    expect(preview.text).toMatch(/WETH after +2 WETH/);
    const fills = () => h.chain.calls.filter(call => call.to === SEAPORT_ADDRESS && !call.data.startsWith('0xf07ec373') && !call.data.startsWith('0x46423aa7'));
    expect(fills()).toHaveLength(0);

    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('Approved exactly 1 WETH to Seaport');
    expect(h.chain.sent).toHaveLength(2);
    const [approval, buy] = h.chain.sent;
    expect(approval!.to).toBe(WETH);
    const approve = decodeFunctionData({ abi: WRAPPED_NATIVE_ABI, data: approval!.data });
    expect(approve.functionName).toBe('approve');
    expect(approve.args).toEqual([expect.stringMatching(new RegExp(SEAPORT_ADDRESS, 'i')), ETH]);
    expect(buy!.to).toBe(SEAPORT_ADDRESS);
    expect(buy!.value).toBe(0n);
    expect(fills().length).toBeGreaterThan(0);
  });

  it('skips the approval when the allowance already covers the purchase', async () => {
    const params = gondiListing({ token: WETH });
    const h = harness({ logsFor: () => [boughtLog(hashOf(params), OTHER_SELLER, { token: COLLECTION, identifier: 7n, amount: 1n }, ETH)] });
    h.chain.wrappedBalance = 3n * ETH;
    h.chain.allowance = 2n * ETH;
    h.api.routes.set('GET /v1/bids', () => []);
    const askId = setupGondi(h, params);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.text).not.toContain('Approve (1 transaction)');
    expect(preview.text).toContain('Simulated just now');
    await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(h.chain.sent).toHaveLength(1);
    expect(h.chain.sent[0]!.value).toBe(0n);
  });

  it('refuses a WETH listing without enough WETH', async () => {
    const h = harness();
    h.chain.wrappedBalance = ETH / 2n;
    const askId = setupGondi(h, gondiListing({ token: WETH }));
    const result = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not enough WETH/);
  });

  it('sweeps an OSWiki ETH listing and a Gondi WETH listing in one transaction', async () => {
    const params = gondiListing({ token: WETH });
    const oswikiAskId = `oswiki-${vectors.orders.erc721.orderHash}`;
    const h = harness();
    h.chain.wrappedBalance = ETH;
    h.chain.allowance = ETH;
    h.api.routes.set('GET /v1/bids', () => []);
    h.api.routes.set(`POST /v1/listings/${oswikiAskId}/buy-data`, () => ({
      askId: oswikiAskId,
      marketplace: 'oswiki',
      to: SEAPORT_ADDRESS,
      value: ETH.toString(),
      orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' },
    }));
    h.api.routes.set(`GET /v1/listings/${oswikiAskId}`, () => ({ contract: { address: COLLECTION }, tokenId: '1', maker: OTHER_SELLER, status: 'active' }));
    const askId = setupGondi(h, params);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [oswikiAskId, askId] });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.text).toContain('Buying 2 OSWiki + Gondi listings');
    expect(preview.text).toMatch(/\nTotal +1 ETH \+ 1 WETH\n/);
    await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    const tx = h.chain.sent[0]!;
    expect(tx.value).toBe(ETH);
    const decoded = decodeFunctionData({ abi: FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, data: tx.data.slice(0, -8) as Hex });
    expect((decoded.args[0] as SeaportAdvancedOrder[])).toHaveLength(2);
  });

  it('counts the WETH price against the per-trade limit', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1.5' } });
    h.chain.wrappedBalance = 3n * ETH;
    const askId = setupGondi(h, gondiListing({ token: WETH, price: 2n * ETH }));
    expect((await h.call('preview_buy', { chainId: 1, askIds: [askId] })).text).toMatch(/above the per-trade limit of 1\.5 ETH/);
  });

  it('includes Gondi listings when picking the cheapest by collection', async () => {
    const params = gondiListing();
    const h = harness();
    const askId = setupGondi(h, params);
    const profile = { address: COLLECTION, name: 'Otherdeed Expanded', slug: 'otherdeed-expanded', verified: true, stats: { floorPrice: 0.9, currency: 'ETH' } };
    h.api.routes.set('GET /v1/collections/otherdeed-expanded', () => profile);
    h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => profile);
    h.api.routes.set('GET /v1/listings', () => [
      { askId: `blur-0x${'cd'.repeat(32)}`, contract: { address: COLLECTION }, tokenId: '3', maker: OTHER_SELLER, price: { amount: { decimal: 0.5 } }, marketplace: 'blur', buyableViaApi: true },
      { askId, contract: { address: COLLECTION }, tokenId: '7', maker: OTHER_SELLER, price: { amount: { decimal: 1 }, currency: { symbol: 'ETH', address: ZERO_ADDRESS } }, marketplace: 'gondi', buyableViaApi: true },
    ]);
    const preview = await h.call('preview_buy', { chainId: 1, collection: 'otherdeed-expanded' });
    expect(preview.isError, preview.text).toBe(false);
    expect(flat(preview.text)).toContain(`- ${askId}: `);
    expect(h.api.requests.filter(request => request.path.endsWith('/buy-data')).map(request => request.path)).toEqual([`/v1/listings/${askId}/buy-data`]);
  });
});
