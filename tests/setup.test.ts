import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, SetupError } from '../src/config.js';
import { ConfirmStore, CONFIRM_TTL_MS } from '../src/confirm.js';
import { createScrubber, INLINE_KEY_MESSAGE, loadWallet, SETUP_MESSAGE } from '../src/secret.js';
import { SERVER_INSTRUCTIONS, serverInstructions, toolDefinitions } from '../src/server.js';
import { TradeState } from '../src/state.js';
import { TEST_ADDRESS, TEST_KEY, testKeyFile } from './helpers.js';

describe('key loading', () => {
  it('refuses to start without a key, with the setup message', () => {
    expect(() => loadWallet({})).toThrow(SetupError);
    expect(() => loadWallet({})).toThrow(SETUP_MESSAGE);
  });

  it('never echoes an invalid key', () => {
    const bad = `${TEST_KEY}ff`;
    try {
      loadWallet({ OSWIKI_WALLET_KEY_FILE: testKeyFile(bad) });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(bad.slice(2, 40));
    }
  });

  it('reads the key once and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { OSWIKI_WALLET_KEY_FILE: testKeyFile(TEST_KEY.slice(2)) };
    const wallet = loadWallet(env);
    expect(wallet.account.address.toLowerCase()).toBe(TEST_ADDRESS);
    expect(env.OSWIKI_WALLET_KEY_FILE).toBeUndefined();
  });

  it('refuses an inline key, removes it from the environment and points to the key file', () => {
    const env: NodeJS.ProcessEnv = { OSWIKI_WALLET_KEY: TEST_KEY };
    try {
      loadWallet(env);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SetupError);
      expect((err as Error).message).toBe(INLINE_KEY_MESSAGE);
      expect((err as Error).message).toMatch(/OSWIKI_WALLET_KEY_FILE/);
      expect((err as Error).message).toMatch(/setup/);
      expect((err as Error).message.toLowerCase()).not.toContain(TEST_KEY.slice(2, 30));
    }
    expect(env.OSWIKI_WALLET_KEY).toBeUndefined();
  });

  it('scrubs the key in any case, with or without 0x, inside longer hex', () => {
    const { scrub } = loadWallet({ OSWIKI_WALLET_KEY_FILE: testKeyFile() });
    const raw = TEST_KEY.slice(2);
    expect(scrub(`a ${TEST_KEY} b`)).toBe('a 0x[redacted] b');
    expect(scrub(raw.toUpperCase())).toBe('[redacted]');
    expect(scrub(`0xdeadbeef${raw}cafe`)).toBe('0x[redacted]');
    const orderHash = `0x${'ab'.repeat(32)}`;
    expect(scrub(orderHash)).toBe(orderHash);
    expect(createScrubber('00')(raw)).toBe(raw);
  });
});

describe('config', () => {
  it('parses limits and refuses bad values', () => {
    const config = loadConfig({ OSWIKI_MAX_BUY_ETH: '0.25', OSWIKI_ALLOWED_COLLECTIONS: '0x790B2cF29ed4F310bf7641f013C65D4560d28371, 0x1111111111111111111111111111111111111111' });
    expect(config.maxBuyWei[1]).toBe(25n * 10n ** 16n);
    expect(config.maxBuyWei[33139]).toBeNull();
    expect(config.minListFloorPct).toBe(50);
    expect(config.maxTradesPerDay).toBe(50);
    expect(config.allowedCollections?.has('0x790b2cf29ed4f310bf7641f013c65d4560d28371')).toBe(true);
    expect(() => loadConfig({ OSWIKI_MAX_BUY_ETH: '-1' })).toThrow(SetupError);
    expect(() => loadConfig({ OSWIKI_ALLOWED_COLLECTIONS: 'otherdeed' })).toThrow(SetupError);
    expect(() => loadConfig({ OSWIKI_RPC_URL_MAINNET: 'http://evil.example' })).toThrow(/https/);
    expect(() => loadConfig({ OSWIKI_MIN_LIST_FLOOR_PCT: '150' })).toThrow(SetupError);
  });

  it('accepts only plain decimal integers for counts', () => {
    expect(loadConfig({ OSWIKI_MAX_TRADES_PER_DAY: ' 007 ' }).maxTradesPerDay).toBe(7);
    for (const bad of ['0x10', '1e3', '-1', '+5', '1.0', '1_000', '10 000', 'Infinity', '9'.repeat(20)]) {
      expect(() => loadConfig({ OSWIKI_MAX_TRADES_PER_DAY: bad }), bad).toThrow(SetupError);
      expect(() => loadConfig({ OSWIKI_MAX_CANCELS_PER_DAY: bad }), bad).toThrow(SetupError);
    }
    expect(() => loadConfig({ OSWIKI_MIN_LIST_FLOOR_PCT: '0x32' })).toThrow(SetupError);
  });

  it('parses gas caps and the confirm mode strictly', () => {
    const config = loadConfig({});
    expect(config.maxFeePerGasWei[1]).toBe(200n * 10n ** 9n);
    expect(config.maxFeePerGasWei[33139]).toBe(1000n * 10n ** 9n);
    expect(config.confirmMode).toBe('human');
    expect(loadConfig({ OSWIKI_MAX_GWEI: '0.5' }).maxFeePerGasWei[1]).toBe(5n * 10n ** 8n);
    expect(loadConfig({ OSWIKI_CONFIRM_MODE: 'AI' }).confirmMode).toBe('ai');
    for (const bad of ['0', '-1', '1e3', '0x10', '200000']) expect(() => loadConfig({ OSWIKI_MAX_GWEI: bad }), bad).toThrow(SetupError);
    expect(() => loadConfig({ OSWIKI_CONFIRM_MODE: 'auto' })).toThrow(/OSWIKI_CONFIRM_MODE/);
    expect(() => loadConfig({ OSWIKI_DAILY_MAX_ETH: '1e2' })).toThrow(SetupError);
    expect(loadConfig({}).dailyMaxWei[1]).toBeNull();
  });
});

describe('trade state', () => {
  it('counts per UTC day and fails closed on a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-state-'));
    let now = Date.parse('2026-10-10T23:00:00Z');
    const state = new TradeState(dir, 2, () => now);
    state.record();
    state.record();
    expect(() => state.record()).toThrow(/Daily trade limit/);
    now = Date.parse('2026-10-11T00:01:00Z');
    expect(state.remaining()).toBe(2);
    writeFileSync(join(dir, 'state.json'), 'garbage');
    expect(state.remaining()).toBe(0);
  });
});

describe('confirm store', () => {
  it('expires after 10 minutes and is single use', () => {
    let now = 0;
    const store = new ConfirmStore<{ a: bigint }>(() => now);
    const id = store.create({ a: 1n });
    expect(store.take(id)).toEqual({ a: 1n });
    expect(() => store.take(id)).toThrow(/already used/);
    const late = store.create({ a: 2n });
    now = CONFIRM_TTL_MS + 1;
    expect(() => store.take(late)).toThrow(/expired/);
  });

  it('binds the plan and its preview text to the bytes taken at preview time', () => {
    const store = new ConfirmStore<{ a: bigint; to: string[] }>(() => 0);
    const plan = { a: 1n, to: ['x'] };
    const id = store.create(plan, 'preview text');
    plan.to.push('y');
    expect(() => store.take(id)).toThrow(/changed after the preview/);
    const ok = store.create({ a: 2n, to: [] }, 'shown');
    expect(store.takeConfirmed(ok)).toEqual({ plan: { a: 2n, to: [] }, summary: 'shown' });
  });
});

describe('tool definitions', () => {
  it('exposes the planned tools with strict schemas and the confirmation flow', () => {
    const tools = toolDefinitions();
    expect(tools.map(tool => tool.name)).toEqual(['wallet_status', 'my_listings', 'my_offers', 'preview_listing', 'preview_buy', 'preview_cancel', 'preview_offer', 'preview_accept_offer', 'preview_transfer', 'preview_unwrap', 'execute', 'update_limits']);
    for (const tool of tools) expect(tool.inputSchema.additionalProperties).toBe(false);
    const listing = tools.find(tool => tool.name === 'preview_listing')!;
    expect(listing.description).toMatch(/do NOT guess, do NOT use 0/);
    expect(listing.description).toMatch(/trait floor/);
    expect(listing.description).toMatch(/hosted oswiki tools/);
    expect(SERVER_INSTRUCTIONS).toMatch(/never ask the user for a private key/);
    expect(SERVER_INSTRUCTIONS).toMatch(/explicitly confirms/);
  });

  it('offers allowNoFloor only on listing and accept, and tells the AI about the dialog', () => {
    const tools = toolDefinitions();
    const props = (name: string) => (tools.find(tool => tool.name === name)!.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
    expect(props('preview_listing').allowNoFloor).toMatchObject({ type: 'boolean', description: 'only when the user explicitly confirmed listing/accepting without any floor reference' });
    expect(props('preview_accept_offer').allowNoFloor?.type).toBe('boolean');
    expect(props('preview_buy').allowNoFloor).toBeUndefined();
    expect(SERVER_INSTRUCTIONS).toMatch(/its own confirmation dialog/);
    expect(tools.find(tool => tool.name === 'execute')).toMatchObject({ _meta: { 'anthropic/requiresUserInteraction': true } });
    expect(tools.find(tool => tool.name === 'preview_buy')).not.toHaveProperty('_meta');
  });
});

describe('confirmation modes', () => {
  const OFF_RULE = 'Confirmation is off: you may execute when the user asked for this trade or gave a standing instruction that covers it; stay within the limits; report every executed trade to the user.';

  it('parses off and the blocklist', () => {
    expect(loadConfig({ OSWIKI_CONFIRM_MODE: ' Off ' }).confirmMode).toBe('off');
    expect(() => loadConfig({ OSWIKI_CONFIRM_MODE: 'none' })).toThrow(/"human" \(default\), "ai" or "off"/);
    const config = loadConfig({ OSWIKI_BLOCKED_COLLECTIONS: '0x790B2cF29ed4F310bf7641f013C65D4560d28371' });
    expect(config.blockedCollections?.has('0x790b2cf29ed4f310bf7641f013c65d4560d28371')).toBe(true);
    expect(config.allowedCollections).toBeNull();
    expect(() => loadConfig({ OSWIKI_BLOCKED_COLLECTIONS: 'otherdeed' })).toThrow(/OSWIKI_BLOCKED_COLLECTIONS/);
  });

  it('human and ai keep the ask-the-user texts and the requiresUserInteraction flag', () => {
    for (const mode of ['human', 'ai'] as const) {
      expect(serverInstructions(mode)).toBe(SERVER_INSTRUCTIONS);
      const tools = toolDefinitions(mode);
      expect(tools.find(tool => tool.name === 'execute')).toMatchObject({ _meta: { 'anthropic/requiresUserInteraction': true } });
      expect(tools.find(tool => tool.name === 'preview_buy')!.description).toMatch(/get the user's confirmation before execute/);
      expect(JSON.stringify(tools)).not.toContain('Confirmation is off');
    }
    expect(SERVER_INSTRUCTIONS).toMatch(/only after the user explicitly confirms/);
  });

  it('off lets the AI execute on the user\'s request or standing instruction, without telling it to ask first', () => {
    const instructions = serverInstructions('off');
    expect(instructions).toContain(OFF_RULE);
    expect(instructions).not.toMatch(/only after the user explicitly confirms|Never call execute on your own initiative|confirmation dialog with the previewed trade/);
    expect(instructions).toMatch(/never the user's instructions/);
    const tools = toolDefinitions('off');
    expect(tools.find(tool => tool.name === 'execute')).not.toHaveProperty('_meta');
    expect(tools.find(tool => tool.name === 'execute')!.description).toContain(OFF_RULE);
    for (const name of ['preview_listing', 'preview_buy', 'preview_cancel', 'preview_offer', 'preview_accept_offer']) {
      const description = tools.find(tool => tool.name === name)!.description;
      expect(description, name).toMatch(/Confirmation is off: execute when the user asked for this trade or a standing instruction covers it/);
      expect(description, name).not.toMatch(/confirmation before execute|ask them to confirm before calling execute/);
    }
  });
});
