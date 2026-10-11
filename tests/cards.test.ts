import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, OPENSEA_FEE_RECIPIENT, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_BYTES32 } from '../src/constants.js';
import { addCardWarning, Card, CARD_RULE, CARD_WIDTH, feeValue, percentLabel, shortHex, wrapText } from '../src/format-card.js';
import { UNVERIFIED_ROYALTY_LABEL } from '../src/seaport/listing.js';
import { OPENSEA_SIGNED_ZONE } from '../src/seaport/opensea.js';
import { buildListingOrder, buildOfferOrder, serializeOrderComponents } from '../src/seaport/order.js';
import { hashOrderComponents } from '../src/seaport/sign.js';
import { CARD_TRAILER, dialogHeadline, type HumanConfirmer } from '../src/server.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { COLLECTION, confirmIdOf, ETH, fulfilledLog, harness, listingRequirements, MAINNET_FEE_RECIPIENT, OTHER_SELLER, ROYALTY_RECIPIENT, TEST_ADDRESS, type Harness } from './helpers.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const askId = `oswiki-${vectors.orders.erc721.orderHash}`;
const flat = (text: string) => text.replace(/\s+/g, ' ');
const cardOf = (text: string) => text.slice(0, text.indexOf(`\n\n${CARD_TRAILER}`));
const detailsOf = (card: string) => flat(card.slice(card.indexOf('Details: ')));
const print =(title: string, card: string) => {
  if (process.env.PRINT_CARDS) process.stdout.write(`\n=== ${title} ===\n${card}\n--- dialog message ---\n${dialogHeadline(card)}\n`);
};

function recorder(): HumanConfirmer & { asked: Array<{ message: string; title?: string }> } {
  const asked: Array<{ message: string; title?: string }> = [];
  return { asked, available: () => true, ask: async (message, title) => { asked.push({ message, title }); return 'declined'; } };
}

function setupBuy(h: Harness, profile: Record<string, unknown> | null, verified: unknown[] = []) {
  h.api.routes.set(`POST /v1/listings/${askId}/buy-data`, () => ({
    askId, to: SEAPORT_ADDRESS, value: '1000000000000000000',
    orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' },
  }));
  h.api.routes.set(`GET /v1/listings/${askId}`, () => ({ contract: { address: COLLECTION }, tokenId: '1', maker: OTHER_SELLER, status: 'active' }));
  h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => {
    if (!profile) throw new Error('down');
    return { address: COLLECTION, ...profile };
  });
  h.api.routes.set('GET /v1/collections', () => verified);
}

const openSeaTerms = { chain: 'ethereum', protocolAddress: SEAPORT_ADDRESS, conduitKey: OPENSEA_CONDUIT_KEY, zone: OPENSEA_SIGNED_ZONE, orderType: 3, feeRecipient: OPENSEA_FEE_RECIPIENT, feeBps: 100, creatorFees: [{ recipient: ROYALTY_RECIPIENT, bps: 500 }] };

function setupListing(h: Harness, options: { floor?: number | null; sales?: unknown[]; tokens?: unknown[]; opensea?: unknown; listings?: unknown[] | null } = {}) {
  h.chain.owners.set(`${COLLECTION}:7`, TEST_ADDRESS);
  h.api.routes.set('GET /v1/orders/params', () => ({ bounds: { minUnitPriceWei: '1000000000000000' } }));
  h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, name: 'Otherdeed Expanded', royalty: { bps: 500, recipient: ROYALTY_RECIPIENT }, stats: { floorPrice: options.floor === undefined ? 0.5 : options.floor, currency: 'ETH' } }));
  h.api.routes.set('GET /v1/sales', () => options.sales ?? []);
  h.api.routes.set(`GET /v1/collections/${COLLECTION}/tokens`, () => options.tokens ?? []);
  h.api.routes.set('GET /v1/listings', () => {
    if (options.listings === null) throw new Error('down');
    return options.listings ?? [];
  });
  h.api.routes.set('POST /v1/listings/requirements', (body) => {
    const items = (body as { items: Array<{ contract: string; tokenId: string; unitPriceWei: string }> }).items;
    const requirements = listingRequirements(1, items, {}, (BigInt(items[0]!.unitPriceWei) / 20n).toString());
    for (const item of requirements.items) (item as Record<string, unknown>).opensea = options.opensea ?? null;
    return requirements;
  });
}

const listArgs = (price: string, extra: Record<string, unknown> = {}) => ({ chainId: 1, items: [{ contract: COLLECTION, tokenId: '7', price }], ...extra });

const ownListing = (price: bigint) => buildListingOrder({ offerer: TEST_ADDRESS, token: COLLECTION, tokenId: '7', isErc1155: false, unitPriceWei: price, feeBps: 100, feeRecipient: MAINNET_FEE_RECIPIENT, counter: 0n, durationSeconds: 86400, nowSeconds: NOW / 1000 - 1000 });

const offerVector = vectors.offers.offerErc721;
const bidId = `oswiki-${offerVector.orderHash}`;
function setupAccept(h: Harness, floor: number | null = 1.2) {
  h.chain.owners.set(`${COLLECTION}:1`, TEST_ADDRESS);
  h.chain.approvals.add(COLLECTION);
  h.api.routes.set(`GET /v1/bids/${bidId}`, () => ({ bidId, kind: 'single-token', tokenId: '1', contract: { address: COLLECTION }, maker: OTHER_SELLER }));
  h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, name: 'Otherdeed Expanded', stats: { floorPrice: floor } }));
  h.api.routes.set(`POST /v1/bids/${bidId}/accept-data`, () => ({
    bidId, kind: 'item', to: SEAPORT_ADDRESS, value: '0', method: 'fulfillBasicOrder_efficient_6GL6yc',
    amounts: { offerWei: '1000000000000000000', feeWei: '10000000000000000', royaltyWei: '50000000000000000', sellerNetWei: '940000000000000000' },
    approval: { token: COLLECTION, operator: OPENSEA_CONDUIT_ADDRESS },
    basicOrderParameters: offerVector.basicOrderParameters,
  }));
}

function setupOffer(h: Harness) {
  h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, name: 'Otherdeed Expanded', stats: { floorPrice: 0.5 } }));
  h.api.routes.set('POST /v1/bids/requirements', (body) => {
    const item = (body as { items: Array<{ kind: string; contract: string; tokenId: string | null; amountWei: string; quantity: number }> }).items[0]!;
    const amount = BigInt(item.amountWei);
    const fee = amount / 100n;
    const royalty = amount / 20n;
    return {
      seaport: SEAPORT_ADDRESS, conduitKey: ZERO_BYTES32, sellerConduitKey: OPENSEA_CONDUIT_KEY,
      currency: { address: WRAPPED_NATIVE[1], symbol: 'WETH', decimals: 18 },
      feeRecipient: MAINNET_FEE_RECIPIENT, feeBps: 100, balanceWei: '0', allowanceWei: '0', openOffersWei: '0',
      requiredAllowanceWei: (amount * BigInt(item.quantity)).toString(),
      items: [{ contract: item.contract, tokenId: item.tokenId, kind: item.kind, isErc1155: false, blocked: false, reason: null, feeWei: fee.toString(), royaltyRecipient: ROYALTY_RECIPIENT, royaltyWei: royalty.toString(), sellerNetWei: (amount - fee - royalty).toString() }],
    };
  });
}

describe('card helper', () => {
  it('right-aligns values at the card width and wraps long labels', () => {
    const text = new Card('purchase', 33139, { irreversible: true })
      .row('Arbinaut #378690', '0.048 APE')
      .row('A very long collection name that will not fit on one line #12', '1 APE')
      .warn('This is a long warning sentence that needs more than one line to be read.', 2)
      .rule()
      .row('Total', '0.048 APE')
      .details(['Seaport 0x0000…b395', null, 'order 0x3c3b…bad4'])
      .render();
    const lines = text.split('\n');
    expect(lines[0]).toBe('APPROVE PURCHASE · ApeChain · cannot be undone');
    expect(lines[1]).toBe(CARD_RULE);
    expect(lines[2]).toBe(`Arbinaut #378690${' '.repeat(CARD_WIDTH - 16 - 9)}0.048 APE`);
    expect(lines[3]!.endsWith('1 APE')).toBe(true);
    expect(lines[3]!.length).toBe(CARD_WIDTH);
    expect(lines[4]).toBe('  not fit on one line #12');
    expect(lines.filter(line => line.startsWith('  ⚠ '))).toHaveLength(1);
    expect(lines.slice(1).every(line => line.length <= CARD_WIDTH)).toBe(true);
    expect(lines.slice(-2)).toEqual(['Details: Seaport 0x0000…b395 ·', 'order 0x3c3b…bad4']);
    expect(lines.at(-3)).toBe(CARD_RULE);
  });

  it('adds a warning above the closing rule and keeps the Details line last', () => {
    const card = new Card('listing', 1).row('X #1', '1 ETH').details(['Seaport 0x0000…b395']).render();
    const lines = addCardWarning(card, 'Confirmation is off.').split('\n');
    expect(lines.slice(-3)).toEqual(['⚠ Confirmation is off.', CARD_RULE, 'Details: Seaport 0x0000…b395']);
  });

  it('formats short ids, percents and fees', () => {
    expect(shortHex('0x0000000000000068F116a894984e2DB1123eB395')).toBe('0x0000…b395');
    expect(shortHex(`oswiki-0x${'3c3b'.padEnd(60, '0')}bad4`)).toBe('0x3c3b…bad4');
    expect(percentLabel(5n, 100n)).toBe('5%');
    expect(percentLabel(25n, 1000n)).toBe('2.5%');
    expect(feeValue({ nowWei: 4n * 10n ** 14n, maxWei: 2n * 10n ** 15n }, 33139)).toBe('~0.0004 APE (max 0.002)');
    expect(feeValue({ nowWei: null, maxWei: 2n * 10n ** 15n }, 1)).toBe('max 0.002 ETH');
    expect(wrapText('a b c', 3)).toEqual(['a b', 'c']);
  });
});

describe('approval cards', () => {
  it('buy: item first, totals, one Details line; the dialog shows exactly the card', async () => {
    const h = harness({ logsFor: () => [fulfilledLog(vectors.orders.erc721.orderHash as Hex, OTHER_SELLER)] });
    setupBuy(h, { name: 'Otherdeed Expanded', verified: true, stats: { floorPrice: 0.5 } });
    const dialog = recorder();
    h.handler.confirmer = dialog;
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
    const card = cardOf(preview.text);
    print('buy', card);
    const lines = card.split('\n');
    expect(lines[0]).toBe('APPROVE PURCHASE · Ethereum · cannot be undone');
    expect(lines[2]).toMatch(/^Otherdeed Expanded #1 +1 ETH$/);
    expect(lines[3]).toBe('  OSWiki · ✓ verified · floor 0.5 ETH');
    expect(card).toMatch(/\nTotal +1 ETH\n/);
    expect(card).toMatch(/\nNetwork fee +~[0-9.]+ ETH \(max [0-9.]+\)\n/);
    expect(card).toMatch(/\nWallet after +~[0-9.]+ ETH\n/);
    expect(detailsOf(card)).toBe(`Details: Seaport 0x0000…b395 · order ${shortHex(vectors.orders.erc721.orderHash)}`);
    expect(card).not.toContain('⚠');
    expect(card).not.toMatch(/the user|confirmId|execute/);
    expect(preview.text).toContain(askId);

    await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(dialog.asked[0]!.message).toBe(card);
    expect(dialog.asked[0]!.title).toBe('Buy for the total shown');
    expect(dialogHeadline(card)).toBe('APPROVE PURCHASE · Ethereum · cannot be undone\nOtherdeed Expanded #1  1 ETH\nTotal  1 ETH');
  });

  it('listing: price, fee, royalty, payout, OpenSea twin, expiry, approval and the cancel of a cheaper listing', async () => {
    const h = harness();
    const cheap = ownListing(ETH / 2n);
    const cheapHash = hashOrderComponents(cheap);
    setupListing(h, { opensea: openSeaTerms, listings: [{ askId: `oswiki-${cheapHash}`, contract: { address: COLLECTION }, tokenId: '7', maker: TEST_ADDRESS }] });
    h.api.routes.set(`GET /v1/orders/asks/oswiki-${cheapHash}/components`, () => ({ parameters: serializeOrderComponents(cheap) }));
    const preview = await h.call('preview_listing', listArgs('1.5', { crossListOpenSea: true }));
    expect(preview.isError).toBe(false);
    const card = cardOf(preview.text);
    print('listing', card);
    const lines = card.split('\n');
    expect(lines[0]).toBe('APPROVE LISTING · Ethereum');
    expect(lines[2]).toMatch(/^Otherdeed Expanded #7 +1\.5 ETH$/);
    expect(lines[3]).toMatch(/^ {2}OSWiki fee 1% +−0\.015 ETH$/);
    expect(lines[4]).toMatch(/^ {2}Royalty 5% → 0x0000…dead +−0\.075 ETH$/);
    expect(flat(card)).toContain(`⚠ Royalty ${UNVERIFIED_ROYALTY_LABEL}.`);
    expect(card).toMatch(/\n {2}You receive +1\.41 ETH\n/);
    expect(card).toMatch(/\n {2}Also on OpenSea at +1\.5[0-9]* ETH\n/);
    expect(card).toMatch(/\n {4}OpenSea fee 1% +−[0-9.]+ ETH\n/);
    expect(card).toMatch(/\n {4}You receive there +[0-9.]+ ETH\n/);
    expect(card).toMatch(/\nExpires +in 30 days \(2026-11-09\)\n/);
    expect(flat(card)).toContain('One-time approval: let the OpenSea conduit move your Otherdeed Expanded when it sells (1 transaction, you pay gas).');
    expect(card).toMatch(/\n {2}- your listing of Otherdeed +0\.5 ETH\n {4}Expanded #7\n/);
    expect(detailsOf(card)).toBe('Details: Seaport 0x0000…b395 · counter 0 · conduit 0x1e00…3c71');
    expect(card).not.toMatch(/the user|confirmId/);
    expect(preview.text).toContain(`oswiki-${cheapHash}`);
    expect(dialogHeadline(card).split('\n')).toEqual([
      'APPROVE LISTING · Ethereum',
      'Otherdeed Expanded #7  1.5 ETH',
      'You receive  1.41 ETH',
      'Also on OpenSea at  1.5 ETH',
      'You receive there  1.41 ETH',
      `⚠ Royalty ${UNVERIFIED_ROYALTY_LABEL}.`,
      `⚠ Creator fee ${UNVERIFIED_ROYALTY_LABEL}.`,
    ]);
  });

  it('offer: amount, what the seller gets, wrap and exact approval steps, expiry', async () => {
    const h = harness();
    setupOffer(h);
    h.chain.wrappedBalance = ETH / 2n;
    const preview = await h.call('preview_offer', { chainId: 1, contract: COLLECTION, price: '0.4', quantity: 3 });
    const card = cardOf(preview.text);
    print('offer', card);
    expect(card.split('\n')[0]).toBe('APPROVE COLLECTION OFFER · Ethereum');
    expect(card).toMatch(/\n3 × any Otherdeed Expanded +1\.2 WETH\n/);
    expect(card).toMatch(/\n {2}Each seller receives +0\.376 WETH\n/);
    expect(card).toMatch(/\nFirst wrap \(1 transaction\) +0\.7 ETH → WETH\n/);
    expect(card).toMatch(/\nApprove \(1 transaction\) +1\.2 WETH\n {2}Seaport may spend exactly this/);
    expect(flat(card)).toContain('never unlimited');
    expect(card).toMatch(/\nExpires +in 7 days \(2026-10-17\)\n/);
    expect(dialogHeadline(card).split('\n')).toEqual([
      'APPROVE COLLECTION OFFER · Ethereum',
      '3 × any Otherdeed Expanded  1.2 WETH',
      'Each seller receives  0.376 WETH',
      'First wrap (1 transaction)  0.7 ETH → WETH',
      'Approve (1 transaction)  1.2 WETH',
    ]);
  });

  it('accept: what you sell, offer, fees, royalty, what you receive', async () => {
    const h = harness();
    setupAccept(h);
    const preview = await h.call('preview_accept_offer', { chainId: 1, bidId, tokenId: '1' });
    const card = cardOf(preview.text);
    print('accept', card);
    const lines = card.split('\n');
    expect(lines[0]).toBe('APPROVE SALE · Ethereum · cannot be undone');
    expect(lines[2]).toBe('Sell Otherdeed Expanded #1');
    expect(lines[3]).toBe(`  to ${shortHex(OTHER_SELLER)} · offer on this token`);
    expect(card).toMatch(/\nOffer +1 WETH\n {2}OSWiki fee 1% +−0\.01 WETH\n {2}Royalty 5% → 0x0000…dead +−0\.05 WETH\n/);
    expect(card).toMatch(/\nYou receive +0\.94 WETH\n/);
    expect(card).toContain('✓ Simulated just now');
    expect(dialogHeadline(card).split('\n')).toEqual([
      'APPROVE SALE · Ethereum · cannot be undone',
      'Sell Otherdeed Expanded #1',
      'Offer  1 WETH',
      'You receive  0.94 WETH',
      `⚠ Royalty ${UNVERIFIED_ROYALTY_LABEL}.`,
    ]);
  });

  it('cancel: plain words for each order with collection, token and price', async () => {
    const listing = ownListing(ETH);
    const listingHash = hashOrderComponents(listing);
    const offer = buildOfferOrder({ offerer: TEST_ADDRESS, kind: 'item', token: COLLECTION, tokenId: '3', isErc1155: false, currency: WRAPPED_NATIVE[1]!, amountWei: 4n * ETH / 10n, feeWei: 4n * ETH / 1000n, feeRecipient: MAINNET_FEE_RECIPIENT, counter: 0n, durationSeconds: 86400, nowSeconds: NOW / 1000 });
    const offerHash = hashOrderComponents(offer);
    const h = harness();
    h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, name: 'Otherdeed Expanded' }));
    h.api.routes.set(`GET /v1/orders/asks/oswiki-${listingHash}/components`, () => ({ parameters: serializeOrderComponents(listing) }));
    h.api.routes.set(`GET /v1/orders/bids/oswiki-${offerHash}/components`, () => ({ parameters: serializeOrderComponents(offer) }));
    const preview = await h.call('preview_cancel', { chainId: 1, askIds: [`oswiki-${listingHash}`], bidIds: [`oswiki-${offerHash}`] });
    expect(preview.isError).toBe(false);
    const card = cardOf(preview.text);
    print('cancel', card);
    const lines = card.split('\n');
    expect(lines[0]).toBe('APPROVE CANCEL · Ethereum');
    expect(lines[2]).toMatch(/^Your listing of Otherdeed Expanded #7 +1 ETH$/);
    expect(card).toMatch(/\nYour offer on Otherdeed Expanded +0\.4 WETH\n {2}#3\n/);
    expect(card).toMatch(/\nTransactions +1\n/);
    expect(card).toMatch(/\nNetwork fee +~[0-9.]+ ETH \(max [0-9.]+\)\n/);
    expect(detailsOf(card)).toBe(`Details: Seaport 0x0000…b395 · ${shortHex(listingHash)} · ${shortHex(offerHash)}`);
  });
});

describe('dialog headline', () => {
  it('summarises many warnings, keeps setting changes and the recipient, and caps the key lines', () => {
    const card = new Card('purchase', 1, { irreversible: true });
    for (let i = 1; i <= 8; i++) card.row(`Item #${i}`, '1 ETH').row('You receive', '1 ETH', 2);
    card.warn('first warning').warn('second warning').warn('third warning').rule().row('Total', '8 ETH');
    const lines = dialogHeadline(card.render()).split('\n');
    expect(lines[0]).toBe('APPROVE PURCHASE · Ethereum · cannot be undone');
    expect(lines).toContain('Item #1  1 ETH');
    expect(lines).toContain('Total  8 ETH');
    expect(lines.filter(line => line.startsWith('You receive'))).toEqual(['You receive  1 ETH']);
    expect(lines.at(-2)).toMatch(/^… and \d+ more lines below$/);
    expect(lines.at(-1)).toBe('⚠ 3 warnings - see below');
    expect(lines.join('\n')).not.toContain('first warning');

    const settings = ['APPROVE SETTING CHANGES', '- OSWIKI_MAX_TRADES_PER_DAY: 10 -> 3', '- OSWIKI_DRY_RUN: 0 -> 1', '', 'They apply right away.'].join('\n');
    expect(dialogHeadline(settings)).toBe('APPROVE SETTING CHANGES\n- OSWIKI_MAX_TRADES_PER_DAY: 10 -> 3\n- OSWIKI_DRY_RUN: 0 -> 1');

    const send = ['APPROVE SEND · Ethereum · cannot be undone', CARD_RULE, 'To   0x1234…abcd  (no ENS name)', '     0x1234000000000000000000000000000000abcd', CARD_RULE, '0.1 ETH  (wallet has 1 ETH)', '⚠ This address has never sent a transaction.'].join('\n');
    expect(dialogHeadline(send)).toBe('APPROVE SEND · Ethereum · cannot be undone\nTo  0x1234…abcd  (no ENS name)\n⚠ This address has never sent a transaction.');
  });
});

describe('every safety warning still reaches the card', () => {
  it('buy: over-floor, unverified, lookalike, missing profile, missing verified list', async () => {
    const real = '0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258';
    const over = harness();
    setupBuy(over, { name: 'Otherdeed Expanded', verified: true, stats: { floorPrice: 0.3 } });
    expect(flat(cardOf((await over.call('preview_buy', { chainId: 1, askIds: [askId] })).text))).toContain('⚠ This costs more than 3x the collection floor (0.3 ETH).');

    const lookalike = harness();
    setupBuy(lookalike, { name: 'Otherdeed Expandd', verified: false, stats: { floorPrice: 0.5 } }, [{ address: real, name: 'Otherdeed Expanded', verified: true }]);
    const card = flat(cardOf((await lookalike.call('preview_buy', { chainId: 1, askIds: [askId] })).text));
    expect(card).toContain('NOT verified');
    expect(card).toContain(`⚠ Otherdeed Expandd is not a verified collection. Make sure this is the contract you mean: ${COLLECTION}`);
    expect(card).toContain(`⚠ "Otherdeed Expandd" looks like the verified collection "Otherdeed Expanded" (${real}), but this is a different contract (${COLLECTION}). It may be a copycat.`);

    const noList = harness();
    setupBuy(noList, { name: 'Somename', verified: false, stats: { floorPrice: 0.5 } });
    noList.api.routes.delete('GET /v1/collections');
    expect(flat(cardOf((await noList.call('preview_buy', { chainId: 1, askIds: [askId] })).text))).toContain('⚠ The verified collection list could not be loaded, so copycat names were not checked.');

    const noProfile = harness();
    setupBuy(noProfile, null);
    expect(flat(cardOf((await noProfile.call('preview_buy', { chainId: 1, askIds: [askId] })).text))).toContain(`⚠ The collection profile could not be loaded, so its name, verified status and floor are unchecked. Make sure this is the contract you mean: ${COLLECTION}`);
  });

  it('listing: low price, floor disagreement, no-floor override, unverified royalty, no OpenSea twin, unloaded listings', async () => {
    const low = harness();
    setupListing(low, { tokens: [{ tokenId: '7', lastSale: { price: 2.1, currency: 'ETH', timestamp: new Date(NOW - 12 * 86_400_000).toISOString() } }] });
    const lowCard = flat(cardOf((await low.call('preview_listing', listArgs('1'))).text));
    expect(lowCard).toContain('⚠ The price is under 70% of the lowest recent sale reference (2.1 ETH).');
    expect(lowCard).toContain(`⚠ Royalty ${UNVERIFIED_ROYALTY_LABEL}.`);

    const noFloor = harness({ env: { OSWIKI_MIN_LIST_FLOOR_PCT: '50' } });
    setupListing(noFloor, { floor: null, listings: null });
    const noFloorCard = flat(cardOf((await noFloor.call('preview_listing', listArgs('0.3', { allowNoFloor: true, crossListOpenSea: true }))).text));
    expect(noFloorCard).toContain('⚠ No floor reference for this collection (the collection has no active listings): the 50% minimum-floor check was skipped because you allowed it');
    expect(noFloorCard).toContain('⚠ #7: NOT cross-listed on OpenSea');
    expect(noFloorCard).toContain('⚠ Could not load your existing listings: a cheaper older listing of the same token would stay fillable.');

    const split = harness();
    setupListing(split, { floor: 0.1, listings: [{ askId: `oswiki-0x${'ab'.repeat(32)}`, contract: { address: COLLECTION }, tokenId: '9', price: { amount: { decimal: 2 } } }] });
    split.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, name: 'Otherdeed Expanded', slug: 'oe', royalty: { bps: 500, recipient: ROYALTY_RECIPIENT }, stats: { floorPrice: 0.1, currency: 'ETH' } }));
    const splitText = await split.call('preview_listing', listArgs('3'));
    expect(flat(cardOf(splitText.text))).toContain('⚠ The API floor (0.1 ETH) and the cheapest active listing on any marketplace (2 ETH) differ by more than 5x; the floor check uses the higher, 2 ETH.');
  });

  it('accept: unverified royalty, floor warning and no-floor override', async () => {
    const h = harness({ env: { OSWIKI_MIN_LIST_FLOOR_PCT: '50' } });
    setupAccept(h, null);
    const card = flat(cardOf((await h.call('preview_accept_offer', { chainId: 1, bidId, tokenId: '1', allowNoFloor: true })).text));
    expect(card).toContain(`⚠ Royalty ${UNVERIFIED_ROYALTY_LABEL}.`);
    expect(card).toContain('⚠ No floor reference for this collection');
  });

  it('confirmation off and AI mode put a notice on the card itself', async () => {
    const off = harness({ env: { OSWIKI_CONFIRM_MODE: 'off' } });
    setupBuy(off, { name: 'Otherdeed Expanded', verified: true, stats: { floorPrice: 0.5 } });
    expect(flat(cardOf((await off.call('preview_buy', { chainId: 1, askIds: [askId] })).text))).toContain('⚠ Autonomous (no dialog): the AI runs this on its own');

    const ai = harness({ env: { OSWIKI_CONFIRM_MODE: 'ai' } });
    ai.handler.confirmer = { available: () => false, ask: async () => 'declined' };
    setupBuy(ai, { name: 'Otherdeed Expanded', verified: true, stats: { floorPrice: 0.5 } });
    expect(flat(cardOf((await ai.call('preview_buy', { chainId: 1, askIds: [askId] })).text))).toContain('⚠ No confirmation dialog here');
  });

  it('keeps instructions for the AI out of the dialog', async () => {
    const h = harness();
    setupBuy(h, { name: 'Otherdeed Expanded', verified: true, stats: { floorPrice: 0.3 } });
    const dialog = recorder();
    h.handler.confirmer = dialog;
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [askId] });
    expect(preview.text).toContain(CARD_TRAILER);
    await h.call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(dialog.asked[0]!.message).not.toContain(CARD_TRAILER);
    expect(dialog.asked[0]!.message).not.toMatch(/with the user|Ask the user|confirmId|call execute/);
    expect(dialog.asked[0]!.message).toContain('⚠ This costs more than 3x');
  });
});
