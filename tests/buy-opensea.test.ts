import { decodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { encodeFulfillAdvancedOrder, FULFILL_ADVANCED_ORDER_ABI, FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, type SeaportAdvancedOrder } from '../src/abi.js';
import { OPENSEA_FEE_RECIPIENT, SEAPORT_ADDRESS, ZERO_ADDRESS } from '../src/constants.js';
import { readAdvancedOrder } from '../src/seaport/fulfill.js';
import { assertOpenSeaSeaportOrder, OpenSeaOrderGuardError, type OpenSeaBuyData } from '../src/seaport/opensea-buy.js';
import { OPENSEA_SIGNED_ZONE } from '../src/seaport/opensea.js';
import { hashOrderComponents } from '../src/seaport/sign.js';
import calldata from './fixtures/seaport-calldata-vectors.json' with { type: 'json' };
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { COLLECTION, confirmIdOf, ETH, fulfilledLog, harness, OTHER_SELLER, ROYALTY_RECIPIENT, TEST_ADDRESS, type Harness } from './helpers.js';

const NOW_SECONDS = BigInt(Date.parse('2026-10-10T12:00:00Z') / 1000);
const BUYER = calldata.buyer as Address;
const EXTRA = '0x0011223344';

type Params = typeof vectors.orders.erc721.parameters;

function toOrder(orderData: Record<string, unknown>): SeaportAdvancedOrder {
  return readAdvancedOrder(orderData, (reason) => {
    throw new Error(reason);
  });
}

function hashOf(params: Params, counter = 0n): Hex {
  const { totalOriginalConsiderationItems: _total, ...components } = toOrder({ parameters: params, signature: '0x00' }).parameters;
  return hashOrderComponents({ ...components, counter });
}

function restricted721(): Params {
  return { ...structuredClone(vectors.orders.erc721.parameters), zone: OPENSEA_SIGNED_ZONE, orderType: 2 };
}

function partial1155(): Params {
  const params = restricted721();
  params.orderType = 3;
  params.salt = BigInt(`0x3d958fe2${'0'.repeat(52)}abcd`).toString();
  params.offer[0] = { ...params.offer[0]!, itemType: 3, startAmount: '5', endAmount: '5' };
  return params;
}

function buyData(params: Params, options: { wallet?: Address; numerator?: number; denominator?: number; extraData?: string; signature?: string; data?: string | null } = {}): OpenSeaBuyData & { orderData: Record<string, unknown> } {
  const wallet = options.wallet ?? BUYER;
  const numerator = options.numerator ?? 1;
  const denominator = options.denominator ?? 1;
  const orderData = {
    numerator,
    denominator,
    parameters: params,
    signature: options.signature ?? vectors.orders.erc721.signature,
    extraData: options.extraData ?? (params.orderType >= 2 ? EXTRA : '0x'),
    fulfillerConduitKey: `0x${'0'.repeat(64)}`,
    recipient: wallet,
    protocol_address: SEAPORT_ADDRESS,
  };
  const total = params.consideration.reduce((sum, c) => sum + BigInt(c.startAmount), 0n) * BigInt(numerator) / BigInt(denominator);
  const units = BigInt(params.offer[0]!.startAmount) * BigInt(numerator) / BigInt(denominator);
  const data = options.data === undefined ? encodeFulfillAdvancedOrder(toOrder(orderData), wallet) : options.data;
  return {
    askId: hashOf(params),
    marketplace: 'opensea',
    to: SEAPORT_ADDRESS,
    value: total.toString(),
    priceWei: total.toString(),
    ...(data === null ? {} : { data }),
    orderData,
    expectedItem: { contract: params.offer[0]!.token, tokenId: params.offer[0]!.identifierOrCriteria, amount: units.toString(), itemType: params.offer[0]!.itemType },
  };
}

const expect721 = { contract: COLLECTION, tokenId: '1', wallet: BUYER, nowSeconds: NOW_SECONDS };

describe('backend calldata vectors', () => {
  it('re-encodes the pinned fulfillAdvancedOrder calldata byte for byte', () => {
    const single = toOrder({ parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' });
    expect(encodeFulfillAdvancedOrder(single, BUYER)).toBe(calldata.single721);
    expect(calldata.signedZone).toBe(OPENSEA_SIGNED_ZONE);
    expect(encodeFulfillAdvancedOrder(toOrder(buyData(restricted721()).orderData), BUYER)).toBe(calldata.restricted721);
    expect(encodeFulfillAdvancedOrder(toOrder(buyData(partial1155(), { numerator: 2, denominator: 5, signature: '0xabcdef' }).orderData), BUYER)).toBe(calldata.partial1155);
  });
});

describe('OpenSea buy guard', () => {
  it('accepts a SignedZone order whose server calldata is the pinned vector', () => {
    const guarded = assertOpenSeaSeaportOrder(buyData(restricted721(), { data: calldata.restricted721 }), expect721);
    expect(guarded.value).toBe(ETH);
    expect(guarded.quantity).toBe(1n);
    expect(guarded.order.extraData).toBe(EXTRA);
  });

  it('accepts a part fill of an ERC-1155 order at the exact fraction', () => {
    const guarded = assertOpenSeaSeaportOrder(buyData(partial1155(), { numerator: 2, denominator: 5, signature: '0xabcdef', data: calldata.partial1155 }), expect721);
    expect(guarded.quantity).toBe(2n);
    expect(guarded.value).toBe(ETH * 2n / 5n);
  });

  it('accepts an open order in any OpenSea fee layout', () => {
    const params = structuredClone(vectors.orders.erc721.parameters);
    params.consideration[1]!.recipient = OPENSEA_FEE_RECIPIENT;
    params.consideration[0]!.recipient = ROYALTY_RECIPIENT;
    expect(() => assertOpenSeaSeaportOrder(buyData(params), expect721)).not.toThrow();
  });

  it('refuses the wrong token or collection', () => {
    expect(() => assertOpenSeaSeaportOrder(buyData(restricted721()), { ...expect721, tokenId: '2' })).toThrow(/expected NFT/);
    expect(() => assertOpenSeaSeaportOrder(buyData(restricted721()), { ...expect721, contract: '0x1111111111111111111111111111111111111111' })).toThrow(/expected collection/);
    const shown = buyData(restricted721());
    shown.expectedItem = { ...(shown.expectedItem as object), tokenId: '2' };
    expect(() => assertOpenSeaSeaportOrder(shown, expect721)).toThrow(/expectedItem/);
  });

  it('refuses a fill whose NFT goes to another wallet', () => {
    const other = '0x2222222222222222222222222222222222222222' as Address;
    expect(() => assertOpenSeaSeaportOrder(buyData(restricted721(), { wallet: other }), expect721)).toThrow(/not go to this wallet/);
    const swapped = buyData(restricted721(), { data: encodeFulfillAdvancedOrder(toOrder(buyData(restricted721()).orderData), other) });
    expect(() => assertOpenSeaSeaportOrder(swapped, expect721)).toThrow(/server calldata/);
  });

  it('refuses a value that is not the exact order total', () => {
    expect(() => assertOpenSeaSeaportOrder({ ...buyData(restricted721()), value: (ETH - 1n).toString() }, expect721)).toThrow(/exact order total/);
    expect(() => assertOpenSeaSeaportOrder({ ...buyData(restricted721()), priceWei: (ETH + 1n).toString() }, expect721)).toThrow(/priceWei/);
  });

  it('refuses non-native or variable consideration', () => {
    const erc20 = restricted721();
    erc20.consideration[2] = { ...erc20.consideration[2]!, itemType: 1, token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' };
    expect(() => assertOpenSeaSeaportOrder(buyData(erc20), expect721)).toThrow(/native/);
    const dutch = restricted721();
    dutch.consideration[0] = { ...dutch.consideration[0]!, endAmount: '1' };
    expect(() => assertOpenSeaSeaportOrder(buyData(dutch), expect721)).toThrow(/fixed/);
  });

  it('refuses an unknown zone, a missing zone authorization, a contract order and an unknown conduit', () => {
    const zoned = { ...restricted721(), zone: '0x1111111111111111111111111111111111111111' };
    expect(() => assertOpenSeaSeaportOrder(buyData(zoned), expect721)).toThrow(/SignedZone/);
    expect(() => assertOpenSeaSeaportOrder(buyData(restricted721(), { extraData: '0x' }), expect721)).toThrow(/authorization/);
    expect(() => assertOpenSeaSeaportOrder(buyData({ ...restricted721(), orderType: 4 }), expect721)).toThrow(/contract orders/);
    expect(() => assertOpenSeaSeaportOrder(buyData({ ...restricted721(), conduitKey: `0x${'12'.repeat(32)}` }), expect721)).toThrow(/conduit/);
  });

  it('refuses expired and not yet active orders', () => {
    const params = restricted721();
    expect(() => assertOpenSeaSeaportOrder(buyData(params), { ...expect721, nowSeconds: BigInt(params.endTime) })).toThrow(/expired/);
    expect(() => assertOpenSeaSeaportOrder(buyData(params), { ...expect721, nowSeconds: BigInt(params.startTime) - 1n })).toThrow(/not active yet/);
  });

  it('refuses data not served as an OpenSea listing or not aimed at Seaport 1.6', () => {
    expect(() => assertOpenSeaSeaportOrder({ ...buyData(restricted721()), marketplace: 'oswiki' }, expect721)).toThrow(OpenSeaOrderGuardError);
    expect(() => assertOpenSeaSeaportOrder({ ...buyData(restricted721()), to: '0x00000000000000adc04c56bf30ac9d3c0aaf14dc' }, expect721)).toThrow(/Seaport 1\.6/);
  });
});

const oswikiAskId = `oswiki-${vectors.orders.erc721.orderHash}`;

function openSeaListing(tokenId = '2'): Params {
  const params = restricted721();
  params.offer[0] = { ...params.offer[0]!, identifierOrCriteria: tokenId };
  params.consideration[1] = { ...params.consideration[1]!, recipient: OPENSEA_FEE_RECIPIENT };
  return params;
}

function setupOpenSea(h: Harness, params: Params, change: (data: ReturnType<typeof buyData>) => unknown = data => data): Hex {
  const askId = hashOf(params);
  h.api.routes.set(`POST /v1/listings/${askId}/buy-data`, () => change(buyData(params, { wallet: TEST_ADDRESS })));
  h.api.routes.set(`GET /v1/listings/${askId}`, () => ({ contract: { address: COLLECTION }, tokenId: params.offer[0]!.identifierOrCriteria, maker: OTHER_SELLER, status: 'active', marketplace: 'opensea' }));
  return askId;
}

function setupOswiki(h: Harness) {
  h.api.routes.set(`POST /v1/listings/${oswikiAskId}/buy-data`, () => ({
    askId: oswikiAskId,
    marketplace: 'oswiki',
    to: SEAPORT_ADDRESS,
    value: ETH.toString(),
    orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x', fulfillerConduitKey: `0x${'0'.repeat(64)}`, recipient: TEST_ADDRESS },
  }));
  h.api.routes.set(`GET /v1/listings/${oswikiAskId}`, () => ({ contract: { address: COLLECTION }, tokenId: '1', maker: OTHER_SELLER, status: 'active' }));
}

describe('preview_buy + execute for OpenSea listings', () => {
  it('buys an OpenSea listing with our own encoding and the zone authorization passed through', async () => {
    const params = openSeaListing();
    const h = harness({ logsFor: () => [fulfilledLog(hashOf(params), OTHER_SELLER)] });
    const askId = setupOpenSea(h, params);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [askId.toUpperCase().replace('0X', '0x')] });
    expect(preview.isError).toBe(false);
    expect(preview.text).toContain('buy 1 OpenSea listing on Ethereum');
    expect(preview.text).toMatch(new RegExp(`- ${askId}: .* #2 for 1 ETH on OpenSea\\n`));
    expect(preview.text).toContain('Total: 1 ETH');
    const request = h.api.requests.find(entry => entry.path.endsWith('/buy-data'))!;
    expect(request.body).toEqual({ chainId: 1, buyer: TEST_ADDRESS });

    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`${askId}: bought`);
    const refetch = h.api.requests.filter(entry => entry.path.endsWith('/buy-data')).at(-1)!;
    expect(refetch.body).toEqual({ chainId: 1, buyer: TEST_ADDRESS, maxPriceWei: ETH.toString() });
    const tx = h.chain.sent[0]!;
    expect(tx.to).toBe(SEAPORT_ADDRESS);
    expect(tx.value).toBe(ETH);
    const decoded = decodeFunctionData({ abi: FULFILL_ADVANCED_ORDER_ABI, data: tx.data.slice(0, -8) as Hex });
    const order = decoded.args[0] as SeaportAdvancedOrder;
    expect(order.extraData).toBe(EXTRA);
    expect(order.parameters.zone.toLowerCase()).toBe(OPENSEA_SIGNED_ZONE);
    expect((decoded.args[3] as string).toLowerCase()).toBe(TEST_ADDRESS);
  });

  it('refuses order data that does not hash to the askId under the live counter', async () => {
    const h = harness();
    const askId = setupOpenSea(h, openSeaListing());
    h.chain.counters.set(OTHER_SELLER, 1n);
    const result = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not hash/);
  });

  it('refuses data for another token, another recipient or another price', async () => {
    for (const change of [
      (data: ReturnType<typeof buyData>) => ({ ...data, orderData: { ...data.orderData, recipient: BUYER } }),
      (data: ReturnType<typeof buyData>) => ({ ...data, value: '1' }),
      (data: ReturnType<typeof buyData>) => ({ ...data, expectedItem: { ...(data.expectedItem as object), tokenId: '9' } }),
    ]) {
      const h = harness();
      const askId = setupOpenSea(h, openSeaListing(), change);
      const result = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/OpenSea order rejected/);
      expect(h.chain.sent).toHaveLength(0);
    }
  });

  it('refuses an OpenSea listing whose token differs from the listing record', async () => {
    const h = harness();
    const params = openSeaListing();
    const askId = setupOpenSea(h, params);
    h.api.routes.set(`GET /v1/listings/${askId}`, () => ({ contract: { address: COLLECTION }, tokenId: '3', maker: OTHER_SELLER, status: 'active' }));
    expect((await h.call('preview_buy', { chainId: 1, askIds: [askId] })).text).toMatch(/expected NFT/);
  });

  it('keeps the per-trade limit for OpenSea listings', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '0.5' } });
    const askId = setupOpenSea(h, openSeaListing());
    expect((await h.call('preview_buy', { chainId: 1, askIds: [askId] })).text).toMatch(/above the per-trade limit of 0\.5 ETH/);
  });

  it('sweeps OSWiki and OpenSea listings together in one transaction', async () => {
    const params = openSeaListing();
    const h = harness({ logsFor: () => [fulfilledLog(vectors.orders.erc721.orderHash as Hex, OTHER_SELLER), fulfilledLog(hashOf(params), OTHER_SELLER)] });
    setupOswiki(h);
    const askId = setupOpenSea(h, params);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [oswikiAskId, askId] });
    expect(preview.isError).toBe(false);
    expect(preview.text).toContain('buy 2 OSWiki + OpenSea listings');
    expect(preview.text).toMatch(new RegExp(`- ${oswikiAskId}: .* #1 for 1 ETH on OSWiki\\n`));
    expect(preview.text).toContain('Total: 2 ETH');
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    const tx = h.chain.sent[0]!;
    expect(tx.value).toBe(2n * ETH);
    const decoded = decodeFunctionData({ abi: FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, data: tx.data.slice(0, -8) as Hex });
    const orders = decoded.args[0] as SeaportAdvancedOrder[];
    expect(orders.map(order => order.extraData)).toEqual(['0x', EXTRA]);
  });

  it('refuses the whole buy when one listing is no longer available', async () => {
    const h = harness();
    setupOswiki(h);
    const askId = setupOpenSea(h, openSeaListing());
    h.api.routes.set(`POST /v1/listings/${askId}/buy-data`, () => new Response(JSON.stringify({ success: false, message: 'This listing is no longer active', code: 'inactive' }), { status: 409 }));
    const result = await h.call('preview_buy', { chainId: 1, askIds: [oswikiAskId, askId] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${askId} cannot be bought`);
    expect(result.text).toContain('(inactive)');
    expect(h.chain.sent).toHaveLength(0);
  });

  it('refuses an OSWiki askId served as another marketplace, and malformed or duplicate ids', async () => {
    const h = harness();
    setupOswiki(h);
    h.api.routes.set(`POST /v1/listings/${oswikiAskId}/buy-data`, () => ({ ...buyData(vectors.orders.erc721.parameters, { wallet: TEST_ADDRESS }), askId: oswikiAskId }));
    expect((await h.call('preview_buy', { chainId: 1, askIds: [oswikiAskId] })).text).toMatch(/not served as an OSWiki listing/);
    expect((await h.call('preview_buy', { chainId: 1, askIds: ['blur-0x1234'] })).text).toMatch(/OpenSea listings \(askId "0x" \+ 64 hex\)/);
    expect((await h.call('preview_buy', { chainId: 1, askIds: [oswikiAskId, vectors.orders.erc721.orderHash] })).text).toMatch(/listed twice/);
    expect(h.api.requests.filter(entry => entry.path.endsWith('/buy-data'))).toHaveLength(1);
  });

  it('accepts an OSWiki fill whose server calldata matches, refuses one that does not', async () => {
    const h = harness();
    setupOswiki(h);
    const order = toOrder({ parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature });
    const base = { askId: oswikiAskId, marketplace: 'oswiki', to: SEAPORT_ADDRESS, value: ETH.toString(), orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' } };
    h.api.routes.set(`POST /v1/listings/${oswikiAskId}/buy-data`, () => ({ ...base, data: encodeFulfillAdvancedOrder(order, TEST_ADDRESS) }));
    expect((await h.call('preview_buy', { chainId: 1, askIds: [oswikiAskId] })).isError).toBe(false);
    h.api.routes.set(`POST /v1/listings/${oswikiAskId}/buy-data`, () => ({ ...base, data: encodeFulfillAdvancedOrder(order, ZERO_ADDRESS) }));
    expect((await h.call('preview_buy', { chainId: 1, askIds: [oswikiAskId] })).text).toMatch(/server calldata/);
  });

  it('aborts at execute when the OpenSea order changed price', async () => {
    const h = harness();
    const params = openSeaListing();
    const askId = setupOpenSea(h, params);
    const confirmId = confirmIdOf((await h.call('preview_buy', { chainId: 1, askIds: [askId] })).text);
    h.api.routes.set(`POST /v1/listings/${askId}/buy-data`, () => new Response(JSON.stringify({ success: false, message: 'The listing costs more, above maxPrice', code: 'price_above_max' }), { status: 409 }));
    const result = await h.call('execute', { confirmId });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('price_above_max');
    expect(h.chain.sent).toHaveLength(0);
  });
});
