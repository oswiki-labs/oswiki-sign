import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { OPENSEA_CONDUIT_ADDRESS, SEAPORT_ADDRESS } from '../src/constants.js';
import { walletStatus } from '../src/flows/status.js';
import { DENY_RULES, isClaudeCode } from '../src/setup.js';
import { TradeState } from '../src/state.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { COLLECTION, confirmIdOf, ETH, flat, fulfilledLog, harness, listingRequirements, OTHER_SELLER, TEST_ADDRESS, type Harness } from './helpers.js';

function setupListing(h: Harness, options: { floor?: number | null; tokens?: number } = {}) {
  for (let id = 1; id <= (options.tokens ?? 60); id++) h.chain.owners.set(`${COLLECTION}:${id}`, TEST_ADDRESS);
  h.chain.approvals.add(COLLECTION);
  h.api.routes.set('GET /v1/orders/params', () => ({ bounds: { minUnitPriceWei: '1000000000000000' } }));
  h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, name: 'Otherdeed Expanded', stats: { floorPrice: options.floor === undefined ? 1 : options.floor, currency: 'ETH' } }));
  h.api.routes.set('GET /v1/sales', () => []);
  h.api.routes.set(`GET /v1/collections/${COLLECTION}/tokens`, () => []);
  h.api.routes.set('GET /v1/listings', () => []);
  h.api.routes.set('POST /v1/listings/requirements', (body) => {
    const items = (body as { items: Array<{ contract: string; tokenId: string }> }).items;
    return listingRequirements(1, items, { items: items.map(item => ({ contract: item.contract, tokenId: item.tokenId, blocked: false, reason: null, royaltyRecipient: null, royaltyWei: '0', opensea: null })) });
  });
  h.api.routes.set('POST /v1/orders/asks', body => ({ askId: `oswiki-${(body as { seaport: { orderHash: string } }).seaport.orderHash}`, status: 'active' }));
}

const list = (tokenId: number | number[], price: string, extra: Record<string, unknown> = {}) => ({
  chainId: 1,
  items: (Array.isArray(tokenId) ? tokenId : [tokenId]).map(id => ({ contract: COLLECTION, tokenId: String(id), price })),
  ...extra,
});

async function listAndExecute(h: Harness, tokenId: number, price: string, extra: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const preview = await h.call('preview_listing', list(tokenId, price, extra));
  if (preview.isError) return preview;
  return h.call('execute', { confirmId: confirmIdOf(preview.text) });
}

describe('sell-side daily budgets: config', () => {
  it('defaults the below-floor budget to the per-buy max and the sell cap to 10x it', () => {
    const config = loadConfig({ OSWIKI_MAX_BUY_ETH: '0.5', OSWIKI_MAX_BUY_APE: '40' });
    expect(config.dailyMaxBelowFloorWei).toEqual({ 1: ETH / 2n, 33139: 40n * ETH });
    expect(config.dailyMaxSellWei).toEqual({ 1: 5n * ETH, 33139: 400n * ETH });
    const listingOnly = loadConfig({});
    expect(listingOnly.dailyMaxBelowFloorWei).toEqual({ 1: 0n, 33139: 0n });
    expect(listingOnly.dailyMaxSellWei).toEqual({ 1: null, 33139: null });
    const explicit = loadConfig({ OSWIKI_MAX_BUY_ETH: '0.5', OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH: '0', OSWIKI_DAILY_MAX_SELL_ETH: '2.5', OSWIKI_DAILY_MAX_BELOW_FLOOR_APE: '7' });
    expect(explicit.dailyMaxBelowFloorWei).toEqual({ 1: 0n, 33139: 7n * ETH });
    expect(explicit.dailyMaxSellWei[1]).toBe(25n * ETH / 10n);
    expect(() => loadConfig({ OSWIKI_DAILY_MAX_SELL_ETH: 'lots' })).toThrow(/decimal amount/);
  });

  it('keeps the counters in the MAC-checked state file, and old files still verify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-sell-state-'));
    const key = new Uint8Array(32).fill(7);
    const now = () => Date.parse('2026-10-10T12:00:00Z');
    const limits = { maxTrades: 50, maxCancels: 50, dailyMaxWei: { 1: null, 33139: null }, dailySellWei: { 1: 10n * ETH, 33139: null }, dailyBelowFloorWei: { 1: ETH, 33139: 0n } };
    const state = new TradeState(dir, 50, now, { macKey: key });
    state.record({ chainId: 1, trades: 1 }, limits);
    expect(new TradeState(dir, 50, now, { macKey: key }).isTampered()).toBe(false);
    state.record({ chainId: 1, trades: 1, sellWei: 3n * ETH, belowFloorWei: ETH / 4n }, limits);
    const fresh = new TradeState(dir, 50, now, { macKey: key });
    expect(fresh.isTampered()).toBe(false);
    expect(fresh.soldToday(1)).toBe(3n * ETH);
    expect(fresh.belowFloorToday(1)).toBe(ETH / 4n);
    expect(() => fresh.check({ chainId: 1, belowFloorWei: ETH }, limits)).toThrow(/Daily below-floor budget on Ethereum/);
    expect(() => fresh.check({ chainId: 33139, belowFloorWei: 1n }, limits)).toThrow(/Selling below the floor on ApeChain is off/);
    expect(() => fresh.check({ chainId: 33139, sellWei: 10n ** 30n }, limits)).not.toThrow();
  });
});

describe('sell-side daily budgets: listings', () => {
  it('attack: an AI listing 50 items at 51% of the floor is refused once the below-floor budget is used up', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1', OSWIKI_CONFIRM_MODE: 'off' } });
    setupListing(h, { floor: 1 });
    const results: Array<{ text: string; isError: boolean }> = [];
    for (let id = 1; id <= 50; id++) results.push(await listAndExecute(h, id, '0.51'));
    const listed = results.filter(result => !result.isError);
    expect(listed).toHaveLength(2);
    expect(results[2]!.text).toMatch(/Daily below-floor budget on Ethereum: 0\.98 ETH given up below the floor today plus 0\.49 ETH would exceed 1 ETH \(OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH/);
    expect(results.slice(2).every(result => result.isError && /below-floor budget/.test(result.text))).toBe(true);
    expect(h.api.requests.filter(request => request.path === '/v1/orders/asks')).toHaveLength(2);
    expect(h.ctx.state.belowFloorToday(1)).toBe(98n * ETH / 100n);

    const bulk = await h.call('preview_listing', list(Array.from({ length: 50 }, (_, i) => i + 1), '0.51'));
    expect(bulk.isError).toBe(true);
    expect(bulk.text).toMatch(/plus 24\.5 ETH would exceed 1 ETH/);

    const atFloor = await listAndExecute(h, 3, '1');
    expect(atFloor.isError).toBe(false);
  });

  it('enforces at execute too: previews made before the budget was spent are refused', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1' } });
    setupListing(h, { floor: 1 });
    const previews = [];
    for (const id of [1, 2, 3]) previews.push(await h.call('preview_listing', list(id, '0.6')));
    expect(previews.every(preview => !preview.isError)).toBe(true);
    expect((await h.call('execute', { confirmId: confirmIdOf(previews[0]!.text) })).isError).toBe(false);
    expect((await h.call('execute', { confirmId: confirmIdOf(previews[1]!.text) })).isError).toBe(false);
    const third = await h.call('execute', { confirmId: confirmIdOf(previews[2]!.text) });
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/below-floor budget .* Nothing was signed or sent\./);
    expect(h.api.requests.filter(request => request.path === '/v1/orders/asks')).toHaveLength(2);
  });

  it('shows the budget left in the preview card and counts the gap per item', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1' } });
    setupListing(h, { floor: 1 });
    const preview = await h.call('preview_listing', list(1, '0.75'));
    const card = flat(preview.text);
    expect(card).toContain('0.25 ETH below the floor, counted toward today\'s below-floor budget.');
    expect(card).toContain('Today on Ethereum after this: below floor 0.75 ETH of 1 ETH left; selling 9.25 ETH of 10 ETH left.');
  });

  it('without a per-buy max: below-floor listings are refused, at or above the floor still works', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '' } });
    setupListing(h, { floor: 1 });
    const below = await h.call('preview_listing', list(1, '0.9'));
    expect(below.isError).toBe(true);
    expect(below.text).toMatch(/Selling below the floor on Ethereum is off: this gives up 0\.1 ETH below the floor and the daily below-floor budget is 0 \(OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH, default OSWIKI_MAX_BUY_ETH\)/);
    const above = await listAndExecute(h, 1, '1.2');
    expect(above.isError).toBe(false);
    expect(flat((await h.call('preview_listing', list(2, '1'))).text)).toContain('below-floor selling off; no daily sell cap');
  });

  it('without a floor the full price counts toward the below-floor budget', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1' } });
    setupListing(h, { floor: null });
    const fits = await h.call('preview_listing', list(1, '0.8', { allowNoFloor: true }));
    expect(fits.isError).toBe(false);
    expect(flat(fits.text)).toContain('No floor: the full 0.8 ETH counts toward today\'s below-floor budget.');
    expect((await h.call('execute', { confirmId: confirmIdOf(fits.text) })).isError).toBe(false);
    const over = await h.call('preview_listing', list(2, '0.3', { allowNoFloor: true }));
    expect(over.text).toMatch(/0\.8 ETH given up below the floor today plus 0\.3 ETH would exceed 1 ETH/);
  });

  it('bounds mass-selling above the floor with the daily sell cap', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1' } });
    setupListing(h, { floor: 1 });
    for (let id = 1; id <= 9; id++) expect((await listAndExecute(h, id, '1.1')).isError).toBe(false);
    const tenth = await listAndExecute(h, 10, '1.1');
    expect(tenth.isError).toBe(true);
    expect(tenth.text).toMatch(/Daily sell limit on Ethereum: 9\.9 ETH listed or sold today plus 1\.1 ETH would exceed 10 ETH \(OSWIKI_DAILY_MAX_SELL_ETH/);
  });
});

describe('sell-side daily budgets: accepted offers', () => {
  function setupAccept(h: Harness, floor: number) {
    const vector = vectors.offers.offerErc721;
    const bidId = `oswiki-${vector.orderHash}`;
    h.chain.owners.set(`${COLLECTION}:1`, TEST_ADDRESS);
    h.chain.approvals.add(COLLECTION);
    h.api.routes.set(`GET /v1/bids/${bidId}`, () => ({ bidId, kind: 'single-token', tokenId: '1', contract: { address: COLLECTION }, maker: OTHER_SELLER }));
    h.api.routes.set(`GET /v1/collections/${COLLECTION}`, () => ({ address: COLLECTION, stats: { floorPrice: floor } }));
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
    return bidId;
  }

  it('counts floor minus the offer and the offer value, and refuses over budget', async () => {
    const vector = vectors.offers.offerErc721;
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1' }, logsFor: () => [fulfilledLog(vector.orderHash as Hex, OTHER_SELLER, { token: COLLECTION, identifier: 1n })] });
    const bidId = setupAccept(h, 1.2);
    const preview = await h.call('preview_accept_offer', { chainId: 1, bidId, tokenId: '1' });
    expect(preview.isError).toBe(false);
    expect(flat(preview.text)).toContain('0.2 ETH below the floor, counted toward today\'s below-floor budget.');
    expect(flat(preview.text)).toContain('below floor 0.8 ETH of 1 ETH left; selling 9 ETH of 10 ETH left');
    expect((await h.call('execute', { confirmId: confirmIdOf(preview.text) })).text).toContain('Sold');
    expect(h.ctx.state.belowFloorToday(1)).toBe(ETH / 5n);
    expect(h.ctx.state.soldToday(1)).toBe(ETH);

    const tight = harness({ env: { OSWIKI_MAX_BUY_ETH: '1', OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH: '0.1' } });
    const tightBid = setupAccept(tight, 1.2);
    const refused = await tight.call('preview_accept_offer', { chainId: 1, bidId: tightBid, tokenId: '1' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/plus 0\.2 ETH would exceed 0\.1 ETH \(OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH/);
  });
});

describe('sell-side daily budgets: status and update_limits', () => {
  it('shows both budgets and their settings in wallet_status', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1', OSWIKI_MAX_BUY_APE: '' } });
    const status = (await h.call('wallet_status')).text;
    expect(status).toContain('- listings and accepted offers today on Ethereum: given up below the floor 0 ETH of 1 ETH used (OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH); value sold 0 ETH of 10 ETH used (OSWIKI_DAILY_MAX_SELL_ETH)');
    expect(status).toContain('- listings and accepted offers today on ApeChain: below the floor: off (OSWIKI_DAILY_MAX_BELOW_FLOOR_APE is 0); value sold: no daily cap (OSWIKI_DAILY_MAX_SELL_APE)');
    expect(status).toContain('- OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH=1 (setup/env)');
    expect(status).toContain('- OSWIKI_DAILY_MAX_SELL_APE=not set (no daily sell cap) (setup/env)');
  });

  it('changes the budgets only after the dialog approves them', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1' } });
    const asked: string[] = [];
    h.handler.confirmer = { available: () => true, ask: async (message) => { asked.push(message); return 'declined'; } };
    expect((await h.call('update_limits', { dailyMaxBelowFloorEth: '5' })).isError).toBe(true);
    expect(h.ctx.config.dailyMaxBelowFloorWei[1]).toBe(ETH);
    expect(asked[0]).toContain('- OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH: 1 -> 5');
    h.handler.confirmer = { available: () => true, ask: async () => 'confirmed' };
    expect((await h.call('update_limits', { dailyMaxBelowFloorEth: '0', dailyMaxSellApe: '300' })).isError).toBe(false);
    expect(h.ctx.config.dailyMaxBelowFloorWei[1]).toBe(0n);
    expect(h.ctx.config.dailyMaxSellWei[33139]).toBe(300n * ETH);
  });
});

describe('wallet_status: Claude Code hardening check', () => {
  function homeWith(deny: string[] | null): string {
    const home = mkdtempSync(join(tmpdir(), 'oswiki-home-'));
    if (deny !== null) {
      mkdirSync(join(home, '.claude'));
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny } }));
    }
    return home;
  }

  it('warns in mode off on Claude Code when deny rules are missing, never otherwise', async () => {
    const off = harness({ env: { OSWIKI_CONFIRM_MODE: 'off' } });
    expect(await walletStatus(off.ctx, { claudeCode: true, home: homeWith(null) })).toContain(`WARNING: confirmation is off and ${DENY_RULES.length} of the ${DENY_RULES.length} oswiki-sign deny rules are missing from ~/.claude/settings.json`);
    expect(await walletStatus(off.ctx, { claudeCode: true, home: homeWith(DENY_RULES.slice(2)) })).toContain('and 2 of the');
    expect(await walletStatus(off.ctx, { claudeCode: true, home: homeWith(DENY_RULES) })).not.toContain('deny rules are missing');
    expect(await walletStatus(off.ctx, { claudeCode: false, home: homeWith(null) })).not.toContain('deny rules are missing');
    const broken = homeWith([]);
    writeFileSync(join(broken, '.claude', 'settings.json'), '{ not json');
    expect(await walletStatus(off.ctx, { claudeCode: true, home: broken })).not.toContain('deny rules are missing');
    const human = harness();
    expect(await walletStatus(human.ctx, { claudeCode: true, home: homeWith(null) })).not.toContain('deny rules are missing');
  });

  it('recognizes Claude Code by its MCP client name', () => {
    expect(isClaudeCode('claude-code')).toBe(true);
    expect(isClaudeCode('Claude Code')).toBe(true);
    expect(isClaudeCode('claude-ai')).toBe(false);
    expect(isClaudeCode('cursor-vscode')).toBe(false);
    expect(isClaudeCode(undefined)).toBe(false);
  });
});
