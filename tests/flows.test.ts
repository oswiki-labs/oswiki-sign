import { decodeFunctionData, encodeErrorResult, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { FULFILL_ADVANCED_ORDER_ABI, NFT_ABI, WRAPPED_NATIVE_ABI } from '../src/abi.js';
import { OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_BYTES32 } from '../src/constants.js';
import { hashOrderComponents, verifySeaportOrderSignature } from '../src/seaport/sign.js';
import { buildListingOrder, buildOfferOrder, pickOrderComponents, serializeOrderComponents } from '../src/seaport/order.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import {
  cancelLogs,
  COLLECTION,
  confirmIdOf,
  ETH,
  boughtLog,
  fulfilledLog,
  flat,
  harness,
  listingRequirements,
  MAINNET_FEE_RECIPIENT,
  OTHER_SELLER,
  ROYALTY_RECIPIENT,
  TEST_ADDRESS,
  TEST_KEY,
  type Harness,
} from './helpers.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function setupListing(h: Harness, options: { floor?: number | null; sales?: unknown[]; tokens?: unknown[]; collectionFails?: boolean } = {}) {
  h.chain.owners.set(`${COLLECTION}:7`, TEST_ADDRESS);
  h.api.routes.set('GET /v1/orders/params', () => ({ bounds: { minUnitPriceWei: '1000000000000000' } }));
  h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => {
    if (options.collectionFails) throw new Error('boom');
    return { address: COLLECTION, name: 'Otherdeed Expanded', royalty: { bps: 500, recipient: ROYALTY_RECIPIENT }, stats: { floorPrice: options.floor === undefined ? 0.5 : options.floor, currency: 'ETH' } };
  });
  h.api.routes.set('GET /v1/sales', () => options.sales ?? []);
  h.api.routes.set(`GET /v1/collections/${COLLECTION}/tokens`, () => options.tokens ?? []);
  h.api.routes.set('GET /v1/listings', () => []);
  h.api.routes.set('POST /v1/listings/requirements', (body) => {
    const items = (body as { items: Array<{ contract: string; tokenId: string; unitPriceWei: string }> }).items;
    return listingRequirements(1, items, {}, (BigInt(items[0]!.unitPriceWei) / 20n).toString());
  });
  h.api.routes.set('POST /v1/orders/asks', body => ({ askId: `oswiki-${(body as { seaport: { orderHash: string } }).seaport.orderHash}`, status: 'active' }));
}

const listArgs = (price: unknown, extra: Record<string, unknown> = {}) => ({ chainId: 1, items: [{ contract: COLLECTION, tokenId: '7', price }], ...extra });

describe('preview_listing + execute', () => {
  it('previews, then approves the conduit, signs locally and submits a verifiable order', async () => {
    const h = harness();
    setupListing(h);
    const preview = await h.call('preview_listing', listArgs('1.5'));
    expect(preview.isError).toBe(false);
    expect(preview.text).toContain('1.5 ETH');
    expect(preview.text).toMatch(/\n {2}You receive +1\.41 ETH\n/);
    expect(flat(preview.text)).toContain('One-time approval: let the OpenSea conduit move your Otherdeed Expanded');
    expect(preview.text).toContain('setApprovalForAll');
    expect(preview.text).toMatch(/Ask the user to confirm, then call execute with confirmId [0-9a-f-]{36}\.$/);

    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    expect(h.chain.sent).toHaveLength(1);
    const approval = decodeFunctionData({ abi: NFT_ABI, data: h.chain.sent[0]!.data });
    expect(h.chain.sent[0]!.to).toBe(COLLECTION);
    expect(approval.args).toEqual([expect.stringMatching(new RegExp(OPENSEA_CONDUIT_ADDRESS, 'i')), true]);

    const submit = h.api.requests.find(request => request.path === '/v1/orders/asks')!;
    const seaport = (submit.body as { seaport: { parameters: Record<string, unknown>; signature: Hex; orderHash: Hex } }).seaport;
    const order = pickOrderComponents(seaport.parameters);
    expect(hashOrderComponents(order)).toBe(seaport.orderHash);
    expect(order.conduitKey).toBe(OPENSEA_CONDUIT_KEY);
    expect(order.consideration.reduce((sum, leg) => sum + leg.startAmount, 0n)).toBe(15n * ETH / 10n);
    expect(order.consideration[1]!.recipient).toBe(MAINNET_FEE_RECIPIENT);
    await expect(verifySeaportOrderSignature({ chainId: 1, offerer: TEST_ADDRESS, orderHash: seaport.orderHash, signature: seaport.signature })).resolves.toBe(true);
    expect(h.ctx.state.tradesToday()).toBe(1);
  });

  it('refuses a wrong fee recipient from the server before anything is signed', async () => {
    const h = harness();
    setupListing(h);
    h.api.routes.set('POST /v1/listings/requirements', body => listingRequirements(1, (body as { items: Array<{ contract: string; tokenId: string }> }).items, { feeRecipient: '0x1111111111111111111111111111111111111111' }));
    const preview = await h.call('preview_listing', listArgs('1'));
    expect(preview.isError).toBe(true);
    expect(preview.text).toMatch(/unexpected fee recipient/);
    expect(h.handler.store.size).toBe(0);
  });

  it('refuses a royalty above 25% and a wrong conduit', async () => {
    const h = harness();
    setupListing(h);
    h.api.routes.set('POST /v1/listings/requirements', body => listingRequirements(1, (body as { items: Array<{ contract: string; tokenId: string }> }).items, {}, (ETH / 2n).toString()));
    expect((await h.call('preview_listing', listArgs('1'))).text).toMatch(/royalty too high/);
    h.api.routes.set('POST /v1/listings/requirements', body => listingRequirements(1, (body as { items: Array<{ contract: string; tokenId: string }> }).items, { conduit: '0x1111111111111111111111111111111111111111' }));
    expect((await h.call('preview_listing', listArgs('1'))).text).toMatch(/unexpected conduit/);
  });

  it('refuses when the counter cannot be read (never defaults to 0)', async () => {
    const h = harness();
    setupListing(h);
    h.chain.counterFails = true;
    const preview = await h.call('preview_listing', listArgs('1'));
    expect(preview.isError).toBe(true);
    expect(preview.text).toMatch(/Seaport counter/);
  });

  it('refuses a token the wallet does not own', async () => {
    const h = harness();
    setupListing(h);
    h.chain.owners.set(`${COLLECTION}:7`, OTHER_SELLER);
    expect((await h.call('preview_listing', listArgs('1'))).text).toMatch(/does not own/);
  });

  it('aborts at execute when the counter changed after the preview', async () => {
    const h = harness();
    setupListing(h);
    const preview = await h.call('preview_listing', listArgs('1'));
    h.chain.counters.set(TEST_ADDRESS, 1n);
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/counter changed/);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.ctx.state.tradesToday()).toBe(0);
  });

  it('cancels a cheaper own listing first and includes its OpenSea twin', async () => {
    const h = harness({ logsFor: tx => (tx.to === SEAPORT_ADDRESS ? cancelLogs([cheapHash], TEST_ADDRESS) : []) });
    setupListing(h);
    h.chain.approvals.add(COLLECTION);
    const cheap = buildListingOrder({ offerer: TEST_ADDRESS, token: COLLECTION, tokenId: '7', isErc1155: false, unitPriceWei: ETH / 2n, feeBps: 100, feeRecipient: MAINNET_FEE_RECIPIENT, counter: 0n, durationSeconds: 86400, nowSeconds: NOW / 1000 - 1000 });
    const cheapHash = hashOrderComponents(cheap);
    h.api.routes.set('GET /v1/listings', () => [{ askId: `oswiki-${cheapHash}`, contract: { address: COLLECTION }, tokenId: '7', maker: TEST_ADDRESS, price: { amount: { decimal: 0.5 } } }]);
    h.api.routes.set(`GET /v1/orders/asks/oswiki-${cheapHash}/components`, () => ({ orderHash: cheapHash, parameters: serializeOrderComponents(cheap) }));

    const preview = await h.call('preview_listing', listArgs('2'));
    expect(flat(preview.text)).toContain('First cancels 1 cheaper listing of yours on-chain');
    expect(preview.text).toMatch(/\n {2}- your listing of Otherdeed +0\.5 ETH\n {4}Expanded #7\n/);
    expect(preview.text).toContain(`Cancels first: oswiki-${cheapHash}.`);
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    expect(h.chain.sent).toHaveLength(1);
    expect(h.chain.sent[0]!.to).toBe(SEAPORT_ADDRESS);
    expect(result.text).toContain('Cancelled 1 cheaper listing');
  });
});

describe('explicit prices and the floor', () => {
  it.each([
    ['0', /greater than 0/],
    [0, /greater than 0/],
    ['-1', /positive decimal/],
    [-1, /positive decimal/],
    ['NaN', /positive decimal/],
    ['floor', /positive decimal/],
    ['abc', /positive decimal/],
    ['1e-7', /positive decimal/],
    ['0.0000000000000000001', /positive decimal/],
  ])('rejects price %s', async (price, message) => {
    const h = harness();
    setupListing(h);
    const result = await h.call('preview_listing', listArgs(price));
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
  });

  it.each([[null], [Number.NaN], [undefined], [{}]])('rejects a missing or non-numeric price (%s)', async (price) => {
    const h = harness();
    setupListing(h);
    const result = await h.call('preview_listing', listArgs(price));
    expect(result.isError).toBe(true);
    expect(h.handler.store.size).toBe(0);
  });

  it('rejects a price under the backend minimum', async () => {
    const h = harness();
    setupListing(h);
    const result = await h.call('preview_listing', listArgs('0.0001'));
    expect(result.text).toMatch(/below the minimum/);
  });

  it('refuses a price under 50% of the floor', async () => {
    const h = harness();
    setupListing(h, { floor: 1 });
    const result = await h.call('preview_listing', listArgs('0.49'));
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/below 50% of the floor/);
    expect((await h.call('preview_listing', listArgs('0.5'))).isError).toBe(false);
  });

  it.each([
    ['null floor', { floor: null }],
    ['0 floor', { floor: 0 }],
  ])('refuses without a floor reference (%s) unless allowNoFloor is set, then keeps the explicit price', async (_name, options) => {
    const h = harness();
    setupListing(h, options);
    const refused = await h.call('preview_listing', listArgs('0.3'));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/No floor reference for this collection.*allowNoFloor: true/);
    expect(h.handler.store.size).toBe(0);
    const result = await h.call('preview_listing', listArgs('0.3', { allowNoFloor: true }));
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/No floor reference for this collection/);
    expect(result.text).toContain('0.3 ETH');
  });

  it('refuses when the collection lookup failed (no floor, royalty unverifiable)', async () => {
    const h = harness();
    setupListing(h, { collectionFails: true });
    expect((await h.call('preview_listing', listArgs('0.3'))).text).toMatch(/No floor reference/);
    expect((await h.call('preview_listing', listArgs('0.3', { allowNoFloor: true }))).text).toMatch(/royalty recipient could not be verified/);
    expect(h.handler.store.size).toBe(0);
  });

  it('lists with an empty orderbook only at the explicit price', async () => {
    const h = harness();
    setupListing(h, { floor: null, sales: [], tokens: [{ tokenId: '7', contract: { address: COLLECTION }, lastSale: null, attributes: [] }] });
    const result = await h.call('preview_listing', listArgs('2', { allowNoFloor: true }));
    expect(flat(result.text)).toContain('no floor (no active listings)');
    expect(flat(result.text)).toContain('no previous sale');
    expect(result.text).not.toMatch(/WARNING/);
  });
});

describe('price references', () => {
  const chaos = [{ traitType: 'Environment', value: 'Chaos' }, { traitType: 'Sediment', value: 'Cosmic Dream' }, { traitType: 'Plot', value: '7' }];
  const tokens = (lastSale: unknown, attributes = chaos) => [{ tokenId: '7', contract: { address: COLLECTION }, lastSale, attributes }];

  it('warns under 70% of the token\'s recent last sale', async () => {
    const h = harness();
    setupListing(h, { tokens: tokens({ price: 2.1, currency: 'ETH', timestamp: daysAgo(12) }) });
    const result = await h.call('preview_listing', listArgs('1'));
    expect(flat(result.text)).toContain('last sale 2.1 ETH (12d ago)');
    expect(flat(result.text)).toMatch(/⚠ The price is under 70% of the lowest recent sale reference \(2\.1 ETH\)/);
    expect(result.isError).toBe(false);
  });

  it('does not warn for a last sale older than 90 days, but still shows it with its age', async () => {
    const h = harness();
    setupListing(h, { tokens: tokens({ price: 2.1, currency: 'ETH', timestamp: daysAgo(120) }) });
    const result = await h.call('preview_listing', listArgs('1'));
    expect(flat(result.text)).toContain('last sale 2.1 ETH (120d ago)');
    expect(result.text).not.toMatch(/WARNING/);
  });

  it('queries Otherdeed sales by Environment + Sediment and warns from them', async () => {
    const h = harness();
    setupListing(h, {
      tokens: tokens(null),
      sales: [
        { tokenId: '8', price: { amount: 1.8, currency: 'WETH' }, timestamp: daysAgo(3) },
        { tokenId: '9', price: { amount: 2.4, currency: 'ETH' }, timestamp: daysAgo(10) },
        { tokenId: '10', price: { amount: 0.2, currency: 'ETH' }, timestamp: daysAgo(200) },
      ],
    });
    const low = await h.call('preview_listing', listArgs('1.2'));
    const salesCall = h.api.requests.find(request => request.path === '/v1/sales')!;
    expect(salesCall.query['traits[Environment]']).toBe('Chaos');
    expect(salesCall.query['traits[Sediment]']).toBe('Cosmic Dream');
    expect(salesCall.query.collection).toBe(COLLECTION);
    expect(flat(low.text)).toContain('recent "Chaos / Cosmic Dream" sales 1.8-2.4 ETH (2, newest 3d ago)');
    expect(flat(low.text)).toMatch(/⚠ .* \(1\.8 ETH\)/);
    const fine = await h.call('preview_listing', listArgs('1.3'));
    expect(fine.text).not.toMatch(/WARNING/);
  });

  it('skips trait sales for collections without known key traits', async () => {
    const other = '0x5b1085136a811e55b2bb2ca1ea456ba82126a376';
    const h = harness();
    setupListing(h);
    h.chain.owners.set(`${other}:7`, TEST_ADDRESS);
    h.api.routes.set(`GET /v1/collections/${other}`, () => ({ address: other, royalty: { bps: 500, recipient: ROYALTY_RECIPIENT }, stats: { floorPrice: 0.5 } }));
    h.api.routes.set(`GET /v1/collections/${other}/tokens`, () => [{ tokenId: '7', contract: { address: other }, attributes: [{ traitType: 'Environment', value: 'Chaos' }] }]);
    const result = await h.call('preview_listing', { chainId: 1, items: [{ contract: other, tokenId: '7', price: '1' }] });
    expect(result.isError).toBe(false);
    expect(h.api.requests.some(request => request.path === '/v1/sales')).toBe(false);
  });

  it('ignores token rows from a sibling contract', async () => {
    const h = harness();
    setupListing(h, { tokens: [{ tokenId: '7', contract: { address: '0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258' }, lastSale: { price: 9, currency: 'ETH', timestamp: daysAgo(1) }, attributes: chaos }] });
    const result = await h.call('preview_listing', listArgs('1'));
    expect(flat(result.text)).toContain('last sale unavailable');
    expect(result.text).not.toMatch(/WARNING/);
  });

  it('shows "unavailable" when a reference call fails instead of blocking', async () => {
    const h = harness();
    setupListing(h, { tokens: tokens(null) });
    h.api.routes.delete('GET /v1/sales');
    expect((await h.call('preview_listing', listArgs('1'))).text.replace(/\s+/g, ' ')).toContain('"Chaos / Cosmic Dream" sales unavailable');
    h.api.routes.delete(`GET /v1/collections/${COLLECTION}/tokens`);
    const result = await h.call('preview_listing', listArgs('1'));
    expect(result.isError).toBe(false);
    expect(flat(result.text)).toContain('last sale unavailable');
  });

  it('batches token references per collection and trait sales per distinct trait set', async () => {
    const h = harness();
    setupListing(h, {
      tokens: [
        { tokenId: '7', contract: { address: COLLECTION }, attributes: chaos },
        { tokenId: '8', contract: { address: COLLECTION }, attributes: chaos },
      ],
    });
    h.chain.owners.set(`${COLLECTION}:8`, TEST_ADDRESS);
    await h.call('preview_listing', { chainId: 1, items: [{ contract: COLLECTION, tokenId: '7', price: '1' }, { contract: COLLECTION, tokenId: '8', price: '1' }] });
    expect(h.api.requests.filter(request => request.path === `/v1/collections/${COLLECTION}/tokens`)).toHaveLength(1);
    expect(h.api.requests.filter(request => request.path === '/v1/sales')).toHaveLength(1);
  });
});

describe('confirmIds', () => {
  it('are single use', async () => {
    const h = harness();
    setupListing(h);
    h.chain.approvals.add(COLLECTION);
    const confirmId = confirmIdOf((await h.call('preview_listing', listArgs('1'))).text);
    expect((await h.call('execute', { confirmId })).isError).toBe(false);
    const again = await h.call('execute', { confirmId });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already used/);
    expect(h.api.requests.filter(request => request.path === '/v1/orders/asks')).toHaveLength(1);
  });

  it('expire after 10 minutes', async () => {
    const h = harness();
    setupListing(h);
    const confirmId = confirmIdOf((await h.call('preview_listing', listArgs('1'))).text);
    h.setNow(NOW + 10 * 60_000 + 1);
    const result = await h.call('execute', { confirmId });
    expect(result.text).toMatch(/expired/);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('are bound to the exact plan', async () => {
    const h = harness();
    setupListing(h);
    const confirmId = confirmIdOf((await h.call('preview_listing', listArgs('1'))).text);
    const entry = (h.handler.store as unknown as { entries: Map<string, { plan: { orders: Array<{ consideration: Array<{ recipient: string }> }> } }> }).entries.get(confirmId)!;
    entry.plan.orders[0]!.consideration[0]!.recipient = OTHER_SELLER;
    const result = await h.call('execute', { confirmId });
    expect(result.text).toMatch(/changed after the preview/);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('reject unknown ids', async () => {
    const h = harness();
    expect((await h.call('execute', { confirmId: 'nope' })).text).toMatch(/Unknown/);
  });
});

describe('limits', () => {
  it('dry run signs and sends nothing', async () => {
    const h = harness({ env: { OSWIKI_DRY_RUN: '1' } });
    setupListing(h);
    const preview = await h.call('preview_listing', listArgs('1'));
    expect(preview.text).toContain('DRY RUN is on');
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.text).toMatch(/DRY RUN/);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.api.requests.some(request => request.path === '/v1/orders/asks')).toBe(false);
    expect(h.ctx.state.tradesToday()).toBe(0);
  });

  it('enforces the daily trade cap across executes', async () => {
    const h = harness({ env: { OSWIKI_MAX_TRADES_PER_DAY: '1' } });
    setupListing(h);
    h.chain.approvals.add(COLLECTION);
    const first = confirmIdOf((await h.call('preview_listing', listArgs('1'))).text);
    const second = confirmIdOf((await h.call('preview_listing', listArgs('1.1'))).text);
    expect((await h.call('execute', { confirmId: first })).isError).toBe(false);
    const blocked = await h.call('execute', { confirmId: second });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/Daily trade limit/);
    h.setNow(NOW + 86_400_000);
    const third = confirmIdOf((await h.call('preview_listing', listArgs('1'))).text);
    expect((await h.call('execute', { confirmId: third })).isError).toBe(false);
  });

  it('turns buys and offers off on a chain without its max-buy limit, listing still works', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '' } });
    setupBuy(h);
    const buy = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(buy.isError).toBe(true);
    expect(buy.text).toMatch(/Buying and offers on Ethereum are off until OSWIKI_MAX_BUY_ETH is set/);
    const offer = await h.call('preview_offer', { chainId: 1, contract: COLLECTION, price: '0.1' });
    expect(offer.text).toMatch(/OSWIKI_MAX_BUY_ETH/);
    expect(h.api.requests.some(request => request.path.includes('buy-data') || request.path === '/v1/bids/requirements')).toBe(false);
    setupListing(h);
    expect((await h.call('preview_listing', listArgs('1'))).isError).toBe(false);
    expect((await h.call('wallet_status')).text).toContain('NOT SET, buys and offers off');
  });

  it('keeps the other chain\'s limit independent', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_APE: '' } });
    const offer = await h.call('preview_offer', { chainId: 33139, contract: COLLECTION, price: '1' });
    expect(offer.text).toMatch(/ApeChain are off until OSWIKI_MAX_BUY_APE/);
    setupBuy(h);
    expect((await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] })).text).not.toMatch(/are off until/);
  });

  it('refuses collections outside the allowlist', async () => {
    const h = harness({ env: { OSWIKI_ALLOWED_COLLECTIONS: '0x1111111111111111111111111111111111111111' } });
    setupListing(h);
    const result = await h.call('preview_listing', listArgs('1'));
    expect(result.text).toMatch(/not in OSWIKI_ALLOWED_COLLECTIONS/);
  });

  it('rejects unknown tool arguments', async () => {
    const h = harness();
    const result = await h.call('preview_listing', { ...listArgs('1'), privateKey: TEST_KEY });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(TEST_KEY.slice(2));
  });
});

const vectorAskId = `oswiki-${vectors.orders.erc721.orderHash}`;

function setupBuy(h: Harness, value = '1000000000000000000') {
  h.api.routes.set(`POST /v1/listings/${vectorAskId}/buy-data`, () => ({
    askId: vectorAskId,
    to: SEAPORT_ADDRESS,
    value,
    orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' },
  }));
  h.api.routes.set(`GET /v1/listings/${vectorAskId}`, () => ({ contract: { address: COLLECTION }, tokenId: '1', maker: OTHER_SELLER, status: 'active' }));
}

describe('preview_buy + execute', () => {
  it('re-encodes the order locally and sends exactly the order total', async () => {
    const h = harness({ logsFor: () => [boughtLog(vectors.orders.erc721.orderHash as Hex, OTHER_SELLER, { token: COLLECTION, identifier: 1n, amount: 1n }, ETH)] });
    setupBuy(h);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(preview.isError).toBe(false);
    expect(preview.text).toMatch(/\nTotal +1 ETH\n/);
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('bought');
    const tx = h.chain.sent[0]!;
    expect(tx.to).toBe(SEAPORT_ADDRESS);
    expect(tx.value).toBe(ETH);
    expect(tx.data.endsWith('da32920a')).toBe(true);
    const decoded = decodeFunctionData({ abi: FULFILL_ADVANCED_ORDER_ABI, data: tx.data.slice(0, -8) as Hex });
    expect((decoded.args[3] as string).toLowerCase()).toBe(TEST_ADDRESS);
  });

  it('refuses a value mismatch from the server', async () => {
    const h = harness();
    setupBuy(h, '900000000000000000');
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(preview.isError).toBe(true);
    expect(preview.text).toMatch(/exact order total/);
  });

  it('refuses order data that does not hash to the askId', async () => {
    const h = harness();
    setupBuy(h);
    h.chain.counters.set(OTHER_SELLER, 3n);
    expect((await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] })).text).toMatch(/does not hash/);
  });

  it('enforces the max buy limit', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '0.5' } });
    setupBuy(h);
    const result = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(result.text).toMatch(/above the per-trade limit of 0\.5 ETH/);
  });

  it('refuses when the simulation reverts', async () => {
    const h = harness();
    setupBuy(h);
    h.chain.seaportRevert = encodeErrorResult({ abi: [{ type: 'error', name: 'OrderIsCancelled', inputs: [{ name: 'orderHash', type: 'bytes32' }] }], errorName: 'OrderIsCancelled', args: [ZERO_BYTES32] });
    const result = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(result.text).toMatch(/cancelled/);
  });

  it('aborts at execute when the listing changed', async () => {
    const h = harness();
    setupBuy(h);
    const confirmId = confirmIdOf((await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] })).text);
    h.chain.counters.set(OTHER_SELLER, 1n);
    const result = await h.call('execute', { confirmId });
    expect(result.isError).toBe(true);
    expect(h.chain.sent).toHaveLength(0);
  });
});

describe('preview_cancel + execute', () => {
  it('cancels only orders that hash to their id and belong to the wallet', async () => {
    const own = buildListingOrder({ offerer: TEST_ADDRESS, token: COLLECTION, tokenId: '7', isErc1155: false, unitPriceWei: ETH, feeBps: 100, feeRecipient: MAINNET_FEE_RECIPIENT, counter: 0n, durationSeconds: 86400 });
    const ownHash = hashOrderComponents(own);
    const h = harness({ logsFor: () => cancelLogs([ownHash], TEST_ADDRESS) });
    h.api.routes.set(`GET /v1/orders/asks/oswiki-${ownHash}/components`, () => ({ parameters: serializeOrderComponents(own) }));
    h.api.routes.set(`GET /v1/orders/asks/${vectorAskId}/components`, () => ({ parameters: vectors.orders.erc721.parameters }));

    expect((await h.call('preview_cancel', { chainId: 1, askIds: [vectorAskId] })).text).toMatch(/Only the maker/);
    h.api.routes.set(`GET /v1/orders/asks/oswiki-${ownHash}/components`, () => ({ parameters: { ...serializeOrderComponents(own), salt: '1' } }));
    expect((await h.call('preview_cancel', { chainId: 1, askIds: [`oswiki-${ownHash}`] })).text).toMatch(/does not match/);
    h.api.routes.set(`GET /v1/orders/asks/oswiki-${ownHash}/components`, () => ({ parameters: serializeOrderComponents(own) }));

    const preview = await h.call('preview_cancel', { chainId: 1, askIds: [`oswiki-${ownHash}`] });
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.text).toContain(`oswiki-${ownHash}: cancelled`);
    expect(h.chain.sent[0]!.to).toBe(SEAPORT_ADDRESS);
  });
});

describe('preview_offer + execute', () => {
  function setupOffer(h: Harness) {
    h.api.routes.set('POST /v1/bids/requirements', (body) => {
      const item = (body as { items: Array<{ kind: string; contract: string; tokenId: string | null; amountWei: string; quantity: number }> }).items[0]!;
      const amount = BigInt(item.amountWei);
      const fee = amount / 100n;
      const royalty = amount / 20n;
      return {
        seaport: SEAPORT_ADDRESS,
        conduitKey: ZERO_BYTES32,
        sellerConduitKey: OPENSEA_CONDUIT_KEY,
        currency: { address: WRAPPED_NATIVE[1], symbol: 'WETH', decimals: 18 },
        feeRecipient: MAINNET_FEE_RECIPIENT,
        feeBps: 100,
        balanceWei: '0',
        allowanceWei: '0',
        openOffersWei: '0',
        requiredAllowanceWei: (amount * BigInt(item.quantity)).toString(),
        items: [{ contract: item.contract, tokenId: item.tokenId, kind: item.kind, isErc1155: false, blocked: false, reason: null, feeWei: fee.toString(), royaltyRecipient: '0x000000000000000000000000000000000000dead', royaltyWei: royalty.toString(), sellerNetWei: (amount - fee - royalty).toString() }],
      };
    });
    h.api.routes.set('POST /v1/orders/bids', body => ({ bidId: `oswiki-${(body as { seaport: { orderHash: string } }).seaport.orderHash}` }));
    h.api.routes.set('POST /v1/orders/bids/bulk', body => ({ results: (body as { offers: unknown[] }).offers.map(() => ({ success: true })), created: (body as { offers: unknown[] }).offers.length, failed: 0 }));
  }

  it('wraps the shortfall, approves exactly the required amount to Seaport and signs a bulk collection offer', async () => {
    const h = harness();
    setupOffer(h);
    h.chain.wrappedBalance = ETH / 2n;
    const preview = await h.call('preview_offer', { chainId: 1, contract: COLLECTION, price: '0.4', quantity: 3 });
    expect(preview.isError).toBe(false);
    expect(preview.text).toMatch(/\nFirst wrap \(1 transaction\) +0\.7 ETH → WETH\n/);
    expect(preview.text).toContain('Approves exactly 1.2 WETH to Seaport');
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    const [wrap, approve] = h.chain.sent;
    expect(wrap!.to).toBe(WRAPPED_NATIVE[1]);
    expect(wrap!.value).toBe(7n * ETH / 10n);
    const decoded = decodeFunctionData({ abi: WRAPPED_NATIVE_ABI, data: approve!.data });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args).toEqual([expect.stringMatching(/0x0000000000000068f116a894984e2db1123eb395/i), 12n * ETH / 10n]);
    const bulk = h.api.requests.find(request => request.path === '/v1/orders/bids/bulk')!;
    const offers = (bulk.body as { offers: Array<{ seaport: { parameters: Record<string, unknown>; signature: Hex; orderHash: Hex } }> }).offers;
    expect(offers).toHaveLength(3);
    for (const offer of offers) {
      await expect(verifySeaportOrderSignature({ chainId: 1, offerer: TEST_ADDRESS, orderHash: offer.seaport.orderHash, signature: offer.seaport.signature })).resolves.toBe(true);
      expect(pickOrderComponents(offer.seaport.parameters).consideration[0]!.itemType).toBe(4);
    }
  });

  it('counts the whole offer against the max buy limit', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1' } });
    setupOffer(h);
    expect((await h.call('preview_offer', { chainId: 1, contract: COLLECTION, price: '0.4', quantity: 3 })).text).toMatch(/per-trade limit/);
  });
});

describe('preview_accept_offer + execute', () => {
  it('accepts an item offer with locally re-encoded calldata', async () => {
    const vector = vectors.offers.offerErc721;
    const bidId = `oswiki-${vector.orderHash}`;
    const h = harness({ logsFor: () => [fulfilledLog(vector.orderHash as Hex, OTHER_SELLER, { token: COLLECTION, identifier: 1n })] });
    h.chain.owners.set(`${COLLECTION}:1`, TEST_ADDRESS);
    h.chain.approvals.add(COLLECTION);
    h.api.routes.set(`GET /v1/bids/${bidId}`, () => ({ bidId, kind: 'single-token', tokenId: '1', contract: { address: COLLECTION }, maker: OTHER_SELLER }));
    h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, stats: { floorPrice: 1.2 } }));
    h.api.routes.set(`POST /v1/bids/${bidId}/accept-data`, () => ({
      bidId,
      kind: 'item',
      to: SEAPORT_ADDRESS,
      value: '0',
      method: 'fulfillBasicOrder_efficient_6GL6yc',
      amounts: { offerWei: '1000000000000000000', feeWei: '10000000000000000', royaltyWei: '50000000000000000', sellerNetWei: '940000000000000000' },
      approval: { token: COLLECTION, operator: OPENSEA_CONDUIT_ADDRESS },
      basicOrderParameters: vector.basicOrderParameters,
    }));
    const preview = await h.call('preview_accept_offer', { chainId: 1, bidId, tokenId: '1' });
    expect(preview.isError).toBe(false);
    expect(preview.text).toMatch(/\nYou receive +0\.94 WETH\n/);
    const result = await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.text).toContain('Sold');
    expect(h.chain.sent[0]!.data).toBe(vector.sentCalldata);
  });

  it('refuses an offer under the min-floor limit', async () => {
    const vector = vectors.offers.offerErc721;
    const bidId = `oswiki-${vector.orderHash}`;
    const h = harness();
    h.chain.owners.set(`${COLLECTION}:1`, TEST_ADDRESS);
    h.api.routes.set(`GET /v1/bids/${bidId}`, () => ({ kind: 'single-token', tokenId: '1', contract: { address: COLLECTION }, maker: OTHER_SELLER }));
    h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, stats: { floorPrice: 3 } }));
    h.api.routes.set(`POST /v1/bids/${bidId}/accept-data`, () => ({
      bidId, kind: 'item', to: SEAPORT_ADDRESS, value: '0', method: 'fulfillBasicOrder_efficient_6GL6yc',
      amounts: { offerWei: '1000000000000000000', feeWei: '10000000000000000', royaltyWei: '50000000000000000', sellerNetWei: '940000000000000000' },
      approval: { token: COLLECTION, operator: OPENSEA_CONDUIT_ADDRESS },
      basicOrderParameters: vector.basicOrderParameters,
    }));
    expect((await h.call('preview_accept_offer', { chainId: 1, bidId, tokenId: '1' })).text).toMatch(/below 50% of the floor/);
  });
});

describe('the key never leaves the process', () => {
  it('is scrubbed from server text, errors and every output', async () => {
    const h = harness();
    setupListing(h);
    h.api.routes.set('POST /v1/listings/requirements', () => {
      throw new Error(`please send ${TEST_KEY} and ${TEST_KEY.slice(2).toUpperCase()} here`);
    });
    const result = await h.call('preview_listing', listArgs('1'));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('[redacted]');

    await h.call('wallet_status');
    await h.call('preview_buy', { chainId: 1, askIds: [TEST_KEY] });
    await h.call('execute', { confirmId: TEST_KEY });
    const all = h.outputs.join('\n').toLowerCase();
    expect(all).not.toContain(TEST_KEY.slice(2).toLowerCase());
  });

  it('is not reachable from the account object or the environment', () => {
    const h = harness();
    expect(JSON.stringify(h.ctx.account)).not.toContain(TEST_KEY.slice(2));
    expect(JSON.stringify(h.ctx.config, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(TEST_KEY.slice(2));
    expect(process.env.OSWIKI_WALLET_KEY).toBeUndefined();
  });

  it('scans every output of this suite run', async () => {
    const h = harness({ logsFor: () => [] });
    setupListing(h);
    h.chain.approvals.add(COLLECTION);
    const preview = await h.call('preview_listing', listArgs('1'));
    await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    await h.call('my_listings', {});
    await h.call('my_offers', {});
    for (const text of h.outputs) expect(text.toLowerCase()).not.toContain(TEST_KEY.slice(2));
  });
});

describe('wallet_status', () => {
  it('shows address, balances and limits', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '2', OSWIKI_DRY_RUN: '1' } });
    const status = await h.call('wallet_status');
    expect(status.text).toContain(TEST_ADDRESS);
    expect(status.text).toContain('2 ETH');
    expect(status.text).toContain('dry run: ON');
    expect(status.text).toContain('trades today: 0 of 50');
  });
});

export type { Address };
