import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { custom, encodeFunctionData, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';

import { NFT_ABI, WRAPPED_NATIVE_ABI } from '../src/abi.js';
import { assertAllowedTx, assertNoPendingTx, createChains, gasLimitCap, networkFee, PendingTxError, sendGuardedTx, TxRefusedError, type PendingTracker } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { OPENSEA_CONDUIT_ADDRESS, SEAPORT_ADDRESS, WRAPPED_NATIVE } from '../src/constants.js';
import { hashOrderComponents } from '../src/seaport/sign.js';
import { buildListingOrder, serializeOrderComponents } from '../src/seaport/order.js';
import { INLINE_KEY_MESSAGE, loadWallet } from '../src/secret.js';
import { CARD_TRAILER, chargeOf, CONFIRM_MODE_HELP, createSignServer, createToolHandler, elicitationConfirmer, NO_HUMAN_CONFIRMER, serverInstructions, toolDefinitions, withSignal, type HumanConfirmer } from '../src/server.js';
import { AI_MODE_WITH_DIALOG } from '../src/flows/limits.js';
import { confirmLine } from '../src/flows/status.js';
import { SettingsStore } from '../src/settings.js';
import { LOCK_STALE_MS, StateLockError, TradeState, type PendingTx } from '../src/state.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { cancelLogs, COLLECTION, confirmIdOf, ETH, fulfilledLog, harness, MAINNET_FEE_RECIPIENT, makeTransport, newChainState, OTHER_SELLER, TEST_ADDRESS, TEST_KEY, testKeyFile, type Harness } from './helpers.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const vectorAskId = `oswiki-${vectors.orders.erc721.orderHash}`;
const vectorHash = vectors.orders.erc721.orderHash as Hex;

function setupBuy(h: Harness) {
  h.api.routes.set(`POST /v1/listings/${vectorAskId}/buy-data`, () => ({
    askId: vectorAskId,
    to: SEAPORT_ADDRESS,
    value: ETH.toString(),
    orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' },
  }));
  h.api.routes.set(`GET /v1/listings/${vectorAskId}`, () => ({ contract: { address: COLLECTION }, tokenId: '1', maker: OTHER_SELLER, status: 'active' }));
}

function ownListing(tokenId: string) {
  const order = buildListingOrder({ offerer: TEST_ADDRESS, token: COLLECTION, tokenId, isErc1155: false, unitPriceWei: ETH, feeBps: 100, feeRecipient: MAINNET_FEE_RECIPIENT, counter: 0n, durationSeconds: 86400 });
  return { order, hash: hashOrderComponents(order) };
}

function setupCancel(h: Harness, tokenIds: string[]): string[] {
  return tokenIds.map((tokenId) => {
    const { order, hash } = ownListing(tokenId);
    h.api.routes.set(`GET /v1/orders/asks/oswiki-${hash}/components`, () => ({ parameters: serializeOrderComponents(order) }));
    return `oswiki-${hash}`;
  });
}

function recorder(decision: 'confirmed' | 'declined' = 'confirmed'): HumanConfirmer & { asked: string[] } {
  const asked: string[] = [];
  return { asked, available: () => true, ask: async (message) => { asked.push(message); return decision; } };
}

async function previewBuy(h: Harness): Promise<string> {
  const preview = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
  expect(preview.isError).toBe(false);
  return preview.text;
}

describe('human confirmation (H2)', () => {
  it('refuses execute when the client has no confirmation dialog, and says so in the preview', async () => {
    const h = harness();
    h.handler.confirmer = NO_HUMAN_CONFIRMER;
    setupBuy(h);
    const text = await previewBuy(h);
    expect(text).toMatch(/cannot show the confirmation dialog, so execute will be refused/);
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot show oswiki-sign's confirmation dialog/);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.ctx.state.tradesToday()).toBe(0);
    expect((await h.call('wallet_status')).text).toMatch(/execute is refused \(OSWIKI_CONFIRM_MODE=human\)/);
  });

  it('runs on the AI confirmation only with OSWIKI_CONFIRM_MODE=ai, and says so loudly', async () => {
    const h = harness({ env: { OSWIKI_CONFIRM_MODE: 'ai' }, logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
    h.handler.confirmer = NO_HUMAN_CONFIRMER;
    setupBuy(h);
    const text = await previewBuy(h);
    expect(text).toMatch(/WARNING - CONFIRM MODE AI/);
    expect((await h.call('wallet_status')).text).toMatch(/WARNING - OSWIKI_CONFIRM_MODE=ai/);
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(false);
    expect(h.chain.sent).toHaveLength(1);
  });

  it('with OSWIKI_CONFIRM_MODE=off runs without the dialog, lets the AI decide and says so in every preview', async () => {
    const h = harness({ env: { OSWIKI_CONFIRM_MODE: 'off' }, logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
    const dialog = recorder('declined');
    h.handler.confirmer = dialog;
    setupBuy(h);
    const text = await previewBuy(h);
    expect(text).toContain('CONFIRMATION OFF (OSWIKI_CONFIRM_MODE=off)');
    expect(text).toContain('Confirmation is off: you may execute when the user asked for this trade or gave a standing instruction that covers it; stay within the limits; report every executed trade to the user.');
    expect(text).not.toMatch(/ask the user|ask them to confirm/i);
    const status = (await h.call('wallet_status')).text;
    expect(status).toContain('Confirmation: OFF (autonomous, no dialog) - trades run on the AI\'s word; a manipulated text could trigger a trade within your limits');
    expect(status).toContain('OSWIKI_CONFIRM_MODE=off');
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(false);
    expect(dialog.asked).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(1);
  });

  it('keeps every configured limit in off mode', async () => {
    const h = harness({ env: { OSWIKI_CONFIRM_MODE: 'off', OSWIKI_MAX_BUY_ETH: '0.5' } });
    h.handler.confirmer = NO_HUMAN_CONFIRMER;
    setupBuy(h);
    const preview = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(preview.isError).toBe(true);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('off mode over a real MCP connection: no elicitation, no requiresUserInteraction, off instructions', async () => {
    const h = harness({ env: { OSWIKI_CONFIRM_MODE: 'off' }, logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
    setupBuy(h);
    const server = createSignServer(h.handler);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    let elicited = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicited++;
      return { action: 'decline' };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getInstructions()).toContain('Confirmation is off: you may execute');
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'execute')).not.toHaveProperty('_meta');
    const preview = await client.callTool({ name: 'preview_buy', arguments: { chainId: 1, askIds: [vectorAskId] } }) as { content: Array<{ text: string }> };
    const result = await client.callTool({ name: 'execute', arguments: { confirmId: confirmIdOf(preview.content[0]!.text) } }) as { isError?: boolean };
    expect(result.isError === true).toBe(false);
    expect(elicited).toBe(0);
    expect(h.chain.sent).toHaveLength(1);
    await client.close();
  });

  it('wallet_status lists the exact settings and how to change them', async () => {
    const h = harness({ env: { OSWIKI_DRY_RUN: '1', OSWIKI_MAX_BUY_ETH: '0.05', OSWIKI_MAX_BUY_APE: '' } });
    const status = (await h.call('wallet_status')).text;
    for (const line of ['- OSWIKI_DRY_RUN=1', '- OSWIKI_CONFIRM_MODE=human', '- OSWIKI_MAX_BUY_ETH=0.05', '- OSWIKI_MAX_BUY_APE=not set (buys and offers off on ApeChain)', '- OSWIKI_DAILY_MAX_ETH=0.15', '- OSWIKI_MIN_LIST_FLOOR_PCT=50', '- OSWIKI_MAX_TRADES_PER_DAY=50', '- OSWIKI_MAX_GWEI=200', '- OSWIKI_ALLOWED_COLLECTIONS=not set (any collection)']) {
      expect(status).toContain(line);
    }
    expect(status).not.toContain('Confirmation: OFF');
    expect(status.trimEnd().split('\n').at(-2)).toBe(`To change limits or confirmation: run \`npx -y @oswikixyz/sign setup\` again in your own terminal (keep the wallet), then restart the AI client.`);
  });

  it('shows the full preview in the dialog and sends nothing when the user declines', async () => {
    const h = harness();
    const dialog = recorder('declined');
    h.handler.confirmer = dialog;
    setupBuy(h);
    const text = await previewBuy(h);
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/did not approve/);
    expect(dialog.asked).toHaveLength(1);
    expect(dialog.asked[0]).toMatch(/\nTotal +1 ETH\n/);
    expect(dialog.asked[0]).toContain(`order ${vectorAskId.slice(7, 13)}…${vectorAskId.slice(-4)}`);
    expect(dialog.asked[0]).not.toContain('confirmId');
    expect(h.chain.sent).toHaveLength(0);
    expect((await h.call('execute', { confirmId: confirmIdOf(text) })).text).toMatch(/already used/);
  });

  it('still asks the human in ai mode when the client has the dialog', async () => {
    const h = harness({ env: { OSWIKI_CONFIRM_MODE: 'ai' } });
    const dialog = recorder('declined');
    h.handler.confirmer = dialog;
    setupBuy(h);
    const result = await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) });
    expect(result.text).toMatch(/did not approve/);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('turns a dialog failure into a refusal', async () => {
    const h = harness();
    h.handler.confirmer = { available: () => true, ask: async () => { throw new Error('timed out'); } };
    setupBuy(h);
    const result = await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) });
    expect(result.text).toMatch(/confirmation dialog failed \(timed out\)/);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('needs no dialog for a dry run', async () => {
    const h = harness({ env: { OSWIKI_DRY_RUN: '1' } });
    const dialog = recorder('declined');
    h.handler.confirmer = dialog;
    setupBuy(h);
    expect((await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) })).text).toMatch(/DRY RUN/);
    expect(dialog.asked).toHaveLength(0);
  });

  it('only accept + confirm=true counts, over a real MCP connection with elicitation', async () => {
    const runs: Array<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown>; sent: number; error: boolean }> = [
      { action: 'accept', content: { confirm: false }, sent: 0, error: true },
      { action: 'decline', sent: 0, error: true },
      { action: 'cancel', sent: 0, error: true },
      { action: 'accept', content: { confirm: true }, sent: 1, error: false },
    ];
    for (const run of runs) {
      const h = harness({ logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
      setupBuy(h);
      const server = createSignServer(h.handler);
      const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
      const messages: string[] = [];
      const descriptions: string[] = [];
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const params = request.params as unknown as { message: string; requestedSchema: { properties: { confirm: { description: string } } } };
        messages.push(params.message);
        descriptions.push(params.requestedSchema.properties.confirm.description);
        return run.content ? { action: run.action, content: run.content } : { action: run.action };
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const preview = await client.callTool({ name: 'preview_buy', arguments: { chainId: 1, askIds: [vectorAskId] } }) as { content: Array<{ text: string }> };
      expect(preview.content[0]!.text).toMatch(/confirmation dialog/);
      const result = await client.callTool({ name: 'execute', arguments: { confirmId: confirmIdOf(preview.content[0]!.text) } }) as { isError?: boolean };
      expect(result.isError === true).toBe(run.error);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^APPROVE PURCHASE · Ethereum · cannot be undone\n/);
      expect(messages[0]).toMatch(/\nTotal {2}1 ETH(\n|$)/);
      expect(messages[0]).not.toContain('─');
      expect(descriptions[0]).toMatch(/\nTotal +1 ETH\n/);
      expect(descriptions[0]).not.toContain('─');
      expect(h.chain.sent).toHaveLength(run.sent);
      await client.close();
    }
  });

  it('a cancelled execute cancels its open dialog and a late answer never trades', async () => {
    const h = harness({ logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
    setupBuy(h);
    const server = createSignServer(h.handler);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    let dialogSignal: AbortSignal | undefined;
    let answer: () => void = () => undefined;
    client.setRequestHandler(ElicitRequestSchema, (_request, extra) => {
      dialogSignal = extra.signal;
      return new Promise(resolve => {
        answer = () => resolve({ action: 'accept', content: { confirm: true } });
      });
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // The SDK ignores notifications/cancelled for request id 0, so the dialog must not be the first server request.
    await server.ping();
    const preview = await client.callTool({ name: 'preview_buy', arguments: { chainId: 1, askIds: [vectorAskId] } }) as { content: Array<{ text: string }> };
    const controller = new AbortController();
    const call = client.callTool({ name: 'execute', arguments: { confirmId: confirmIdOf(preview.content[0]!.text) } }, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(dialogSignal).toBeDefined());
    controller.abort();
    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(dialogSignal!.aborted).toBe(true));
    answer();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.chain.sent).toHaveLength(0);
    await client.close();
  });

  it('withSignal declines a pending ask when the call is cancelled, even if the confirmer ignores the signal', async () => {
    let release: (decision: 'confirmed') => void = () => undefined;
    const seen: Array<AbortSignal | undefined> = [];
    const stubborn: HumanConfirmer = { available: () => true, ask: (_message, _title, signal) => { seen.push(signal); return new Promise(resolve => { release = resolve; }); } };
    const controller = new AbortController();
    const pending = withSignal(stubborn, controller.signal).ask('card', 'title');
    controller.abort();
    await expect(pending).resolves.toBe('declined');
    release('confirmed');
    expect(seen[0]).toBe(controller.signal);
    await expect(withSignal(stubborn, controller.signal).ask('card')).resolves.toBe('declined');
    expect(seen).toHaveLength(1);
    expect(withSignal(stubborn, undefined)).toBe(stubborn);
  });

  it('treats a client without the elicitation capability as having no dialog', async () => {
    const h = harness();
    setupBuy(h);
    const server = createSignServer(h.handler, { env: { OSWIKI_BROWSER_APPROVAL: '0' } });
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(elicitationConfirmer(server).available()).toBe(false);
    const preview = await client.callTool({ name: 'preview_buy', arguments: { chainId: 1, askIds: [vectorAskId] } }) as { content: Array<{ text: string }> };
    const result = await client.callTool({ name: 'execute', arguments: { confirmId: confirmIdOf(preview.content[0]!.text) } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/OSWIKI_CONFIRM_MODE=ai/);
    expect(h.chain.sent).toHaveLength(0);
    await client.close();
  });

  it('a handler without a server has no human confirmer', () => {
    const h = harness();
    const plain = createToolHandler(h.ctx, text => text);
    expect(plain.confirmer.available()).toBe(false);
  });
});

describe('collection blocklist', () => {
  it('refuses buys on a blocked collection in every confirmation mode, but still cancels', async () => {
    for (const mode of ['human', 'ai', 'off']) {
      const h = harness({ env: { OSWIKI_CONFIRM_MODE: mode, OSWIKI_BLOCKED_COLLECTIONS: COLLECTION } });
      setupBuy(h);
      const buy = await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
      expect(buy.isError, mode).toBe(true);
      expect(buy.text).toMatch(/is blocked \(OSWIKI_BLOCKED_COLLECTIONS\)/);
    }
    const h = harness({ env: { OSWIKI_BLOCKED_COLLECTIONS: COLLECTION } });
    const ids = setupCancel(h, ['1']);
    const cancel = await h.call('preview_cancel', { chainId: 1, askIds: ids });
    expect(cancel.isError).toBe(false);
  });

  it('needs allowed AND not blocked when both are set', async () => {
    const h = harness({ env: { OSWIKI_ALLOWED_COLLECTIONS: COLLECTION, OSWIKI_BLOCKED_COLLECTIONS: COLLECTION } });
    setupBuy(h);
    expect((await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] })).text).toMatch(/is blocked/);
  });
});

describe('update_limits', () => {
  function dialog(decision: 'confirmed' | 'declined' = 'confirmed'): HumanConfirmer & { asked: string[] } {
    const asked: string[] = [];
    return { asked, available: () => true, ask: async (message) => { asked.push(message); return decision; } };
  }

  it('shows every change, tighter too, as old -> new and applies it only after approval, without a restart', async () => {
    const h = harness({ env: { OSWIKI_MAX_BUY_ETH: '1000' } });
    const approve = dialog();
    h.handler.confirmer = approve;
    setupBuy(h);
    const result = await h.call('update_limits', { maxBuyEth: '0.5', maxTradesPerDay: 10 });
    expect(result.isError).toBe(false);
    expect(approve.asked).toHaveLength(1);
    expect(approve.asked[0]).toContain('- OSWIKI_MAX_BUY_ETH: 1000 -> 0.5');
    expect(approve.asked[0]).toContain('- OSWIKI_MAX_TRADES_PER_DAY: 50 -> 10');
    expect(approve.asked[0]).toMatch(/^APPROVE SETTING CHANGES\n/);
    expect(h.ctx.config.maxBuyWei[1]).toBe(ETH / 2n);
    expect((await h.call('preview_buy', { chainId: 1, askIds: [vectorAskId] })).text).toMatch(/above the per-trade limit of 0\.5 ETH/);
    const status = (await h.call('wallet_status')).text;
    expect(status).toContain('- OSWIKI_MAX_BUY_ETH=0.5 (chat)');
    expect(status).toContain('- OSWIKI_MAX_BUY_APE=100000 (setup/env)');
  });

  it('loosening needs the dialog too, and a declined dialog changes nothing', async () => {
    const h = harness({ env: { OSWIKI_CONFIRM_MODE: 'off' } });
    const decline = dialog('declined');
    h.handler.confirmer = decline;
    const result = await h.call('update_limits', { maxBuyEth: '5000', dryRun: false, blockedCollections: { remove: [COLLECTION] } });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/did not approve the setting changes/);
    expect(decline.asked).toHaveLength(1);
    expect(h.ctx.config.maxBuyWei[1]).toBe(1000n * ETH);
    expect(h.settings.overrides).toEqual({});
    expect(existsSync(join(h.ctx.config.stateDir, 'settings.json'))).toBe(false);
  });

  it('refuses every change when the client has no dialog, and points to setup', async () => {
    const h = harness();
    h.handler.confirmer = NO_HUMAN_CONFIRMER;
    for (const args of [{ maxBuyEth: '1' }, { dryRun: true }, { confirmMode: 'off' }]) {
      const result = await h.call('update_limits', args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/cannot show it while the browser approval page is switched off \(OSWIKI_BROWSER_APPROVAL=0\)\. The user can run `npx -y @oswikixyz\/sign@.* setup` again/);
    }
    expect(h.settings.overrides).toEqual({});
  });

  it('takes addresses only and refuses emptying the allowlist into "any" without clear', async () => {
    const h = harness({ env: { OSWIKI_ALLOWED_COLLECTIONS: COLLECTION } });
    h.handler.confirmer = dialog();
    expect((await h.call('update_limits', { blockedCollections: { add: ['otherdeed'] } })).text).toMatch(/0x collection addresses only/);
    expect((await h.call('update_limits', { allowedCollections: { remove: [COLLECTION] } })).text).toMatch(/would allow any collection/);
    expect((await h.call('update_limits', { allowedCollections: { clear: true } })).isError).toBe(false);
    expect(h.ctx.config.allowedCollections).toBeNull();
  });

  it('persists approved changes, MAC-checked: a tampered settings.json is ignored with a warning', async () => {
    const h = harness();
    h.handler.confirmer = dialog();
    await h.call('update_limits', { maxBuyEth: '2', confirmMode: 'off' });
    const file = join(h.ctx.config.stateDir, 'settings.json');
    const again = SettingsStore.fromEnv({ OSWIKI_SIGN_STATE_DIR: h.ctx.config.stateDir, OSWIKI_MAX_BUY_ETH: '1000' }, loadWallet({ OSWIKI_WALLET_KEY_FILE: testKeyFile() }).stateKey);
    expect(again.load().maxBuyWei[1]).toBe(2n * ETH);
    expect(again.load().confirmMode).toBe('off');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"2"', '"9000"'));
    const tampered = again.load();
    expect(tampered.maxBuyWei[1]).toBe(1000n * ETH);
    expect(tampered.confirmMode).toBe('human');
    expect(again.warning).toMatch(/failed its integrity check/);
    const otherWallet = SettingsStore.fromEnv({ OSWIKI_SIGN_STATE_DIR: h.ctx.config.stateDir }, loadWallet({ OSWIKI_WALLET_KEY_FILE: testKeyFile(`0x${'11'.repeat(32)}`) }).stateKey);
    h.handler.confirmer = dialog();
    await h.call('update_limits', { maxBuyEth: '3' });
    expect(otherWallet.load().maxBuyWei[1]).toBeNull();
    expect(otherWallet.warning).toMatch(/integrity check/);
  });
});

describe('confirmation modes are unambiguous (0.2.2)', () => {
  const trailerOf = (text: string) => text.slice(text.indexOf(CARD_TRAILER));

  it('describes off as the way to stop approving trades and ai as dialog-less clients only', () => {
    const tool = toolDefinitions('human').find(entry => entry.name === 'update_limits')!;
    const description = ((tool.inputSchema.properties as Record<string, { description?: string }>).confirmMode)!.description!;
    expect(description).toBe(CONFIRM_MODE_HELP);
    expect(description).toMatch(/^off = autonomous: the AI trades on its own within the limits, no dialog; use this when the user wants to stop approving trades\./);
    expect(description).toMatch(/human = the user approves every trade .*\(default\)/);
    expect(description).toMatch(/ai = only for clients WITHOUT dialog support/);
    expect(tool.description).toContain('set confirmMode "off" (autonomous, no dialog), not "ai"');
    for (const mode of ['human', 'ai', 'off'] as const) expect(serverInstructions(mode)).toContain(CONFIRM_MODE_HELP);
  });

  it('setting ai on a client with the dialog says the dialog stays and points to off', async () => {
    const h = harness();
    const approve = recorder();
    h.handler.confirmer = approve;
    const result = await h.call('update_limits', { confirmMode: 'ai' });
    expect(result.isError).toBe(false);
    expect(approve.asked[0]).toContain('- OSWIKI_CONFIRM_MODE: human (dialog for every trade) -> ai (dialog if the client supports it, otherwise the AI\'s confirmation)');
    expect(result.text).toContain(AI_MODE_WITH_DIALOG);
    expect((await h.call('update_limits', { confirmMode: 'ai' })).text).toContain(AI_MODE_WITH_DIALOG);
    const off = await h.call('update_limits', { confirmMode: 'off' });
    expect(off.text).toContain('Confirmation mode is now off (autonomous, no dialog), in effect immediately');
    expect(off.text).not.toContain(AI_MODE_WITH_DIALOG);
  });

  it('wallet_status reflects the effective mode, also after a chat change', async () => {
    const h = harness();
    expect((await h.call('wallet_status')).text).toContain('- confirmation: human (OSWIKI_CONFIRM_MODE=human): you approve every trade in the dialog');
    await h.call('update_limits', { confirmMode: 'ai' });
    const ai = (await h.call('wallet_status')).text;
    expect(ai).toContain('dialog when the client supports it (yours does');
    expect(ai).not.toMatch(/approves every execute/);
    h.handler.confirmer = NO_HUMAN_CONFIRMER;
    expect((await h.call('wallet_status')).text).toContain('dialog when the client supports it (yours doesn\'t), otherwise the AI\'s confirmation');
    h.handler.confirmer = recorder();
    await h.call('update_limits', { confirmMode: 'off' });
    expect((await h.call('wallet_status')).text).toContain('- confirmation: autonomous (no dialog, OSWIKI_CONFIRM_MODE=off): the AI trades on its own within your limits; sends and limit changes still need the dialog');
    expect(confirmLine('off', true)).toBe(confirmLine('off', false));
  });

  it('preview trailers match what execute does in every mode', async () => {
    const cases = [
      { mode: 'human', dialog: true, has: /asks the user to approve this exact trade in its own confirmation dialog/ },
      { mode: 'human', dialog: false, has: /cannot show the confirmation dialog, so execute will be refused/ },
      { mode: 'ai', dialog: true, has: /asks the user to approve this exact trade in its own confirmation dialog/ },
      { mode: 'ai', dialog: false, has: /WARNING - CONFIRM MODE AI.*no confirmation dialog/ },
      { mode: 'off', dialog: true, has: /AUTONOMOUS - CONFIRMATION OFF.*shows no dialog for this trade/ },
      { mode: 'off', dialog: false, has: /AUTONOMOUS - CONFIRMATION OFF.*shows no dialog for this trade/ },
    ] as const;
    for (const { mode, dialog, has } of cases) {
      const h = harness({ env: { OSWIKI_CONFIRM_MODE: mode }, logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
      const approve = recorder();
      h.handler.confirmer = dialog ? approve : NO_HUMAN_CONFIRMER;
      setupBuy(h);
      const text = await previewBuy(h);
      const trailer = trailerOf(text);
      expect(trailer, `${mode}/${dialog}`).toMatch(has);
      if (mode === 'off') expect(trailer).not.toMatch(/asks the user to approve|approval dialog|Ask the user to confirm|will open/i);
      const result = await h.call('execute', { confirmId: confirmIdOf(text) });
      const opened = approve.asked.length === 1;
      expect(opened, `${mode}/${dialog} dialog`).toBe(/asks the user to approve/.test(trailer));
      expect(result.isError, `${mode}/${dialog} refused`).toBe(/will be refused/.test(trailer));
    }
  });

  it('changing the mode sends tools/list_changed and says what applies when', async () => {
    const h = harness();
    const server = createSignServer(h.handler);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm: true } }));
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'update_limits', arguments: { confirmMode: 'off' } }) as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    expect(text).toContain('in effect immediately for the next execute');
    expect(text).toContain('The client was told to refresh the tool descriptions (tools/list_changed)');
    expect(text).toContain('the server instructions update after a client restart');
    await vi.waitFor(() => expect(changed).toBe(1));
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'execute')).not.toHaveProperty('_meta');
    expect(tools.find(tool => tool.name === 'execute')!.description).toContain('Autonomous: no confirmation dialog');
    await client.callTool({ name: 'update_limits', arguments: { maxTradesPerDay: 10 } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(changed).toBe(1);
    await client.close();
  });
});

describe('confirmIds bound to the preview bytes', () => {
  it('refuses when the stored preview text was changed', async () => {
    const h = harness();
    setupBuy(h);
    const confirmId = confirmIdOf(await previewBuy(h));
    const entry = (h.handler.store as unknown as { entries: Map<string, { summary: string }> }).entries.get(confirmId)!;
    entry.summary = entry.summary.replace('1 ETH', '0.1 ETH');
    expect((await h.call('execute', { confirmId })).text).toMatch(/changed after the preview/);
    expect(h.chain.sent).toHaveLength(0);
  });
});

describe('daily value and cancel caps (M4)', () => {
  it('defaults the daily spend cap to 3x the per-buy cap', () => {
    const config = loadConfig({ OSWIKI_MAX_BUY_ETH: '0.5', OSWIKI_DAILY_MAX_APE: '10' });
    expect(config.dailyMaxWei[1]).toBe(15n * 10n ** 17n);
    expect(config.dailyMaxWei[33139]).toBe(10n * ETH);
    expect(config.maxCancelsPerDay).toBe(200);
  });

  it('sums buy spend per UTC day and chain', async () => {
    const h = harness({ env: { OSWIKI_DAILY_MAX_ETH: '1.5' }, logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
    setupBuy(h);
    expect((await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) })).isError).toBe(false);
    expect(h.ctx.state.spentToday(1)).toBe(ETH);
    const blocked = await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/Daily spend limit on Ethereum: 1 ETH used today plus 1 ETH would exceed 1\.5 ETH \(OSWIKI_DAILY_MAX_ETH/);
    expect(blocked.text).toMatch(/offer to raise this limit with update_limits/);
    expect(h.chain.sent).toHaveLength(1);
    h.setNow(NOW + 86_400_000);
    expect((await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) })).isError).toBe(false);
  });

  it('counts every item of an execute and new offer amounts', () => {
    const listing = { kind: 'listing', chainId: 1, items: [{}, {}, {}], cancels: [{ id: 'a' }, { id: 'b', twinOf: 'a' }] } as never;
    expect(chargeOf(listing)).toEqual({ chainId: 1, trades: 3, cancels: 1 });
    expect(chargeOf({ kind: 'offer', chainId: 33139, quantity: 4, amountWei: 2n * ETH } as never)).toEqual({ chainId: 33139, trades: 4, spendWei: 8n * ETH });
    expect(chargeOf({ kind: 'buy', chainId: 1, entries: [{}, {}], totalValue: 5n } as never)).toEqual({ chainId: 1, trades: 2, spendWei: 5n });
    expect(chargeOf({ kind: 'cancel', chainId: 1, targets: [{ id: 'a' }, { id: 'b' }, { id: 'c', twinOf: 'b' }] } as never)).toEqual({ chainId: 1, cancels: 2 });
  });

  it('caps cancels per day, counting each order', async () => {
    const hashes: Hex[] = [];
    const h = harness({ env: { OSWIKI_MAX_CANCELS_PER_DAY: '2' }, logsFor: () => cancelLogs(hashes, TEST_ADDRESS) });
    const ids = setupCancel(h, ['1', '2', '3']);
    hashes.push(...ids.map(id => id.slice(7) as Hex));
    const first = await h.call('preview_cancel', { chainId: 1, askIds: ids.slice(0, 2) });
    expect(first.text).toMatch(/Network fee: about .* now, at most/);
    expect((await h.call('execute', { confirmId: confirmIdOf(first.text) })).isError).toBe(false);
    expect(h.ctx.state.cancelsToday()).toBe(2);
    const second = await h.call('execute', { confirmId: confirmIdOf((await h.call('preview_cancel', { chainId: 1, askIds: [ids[2]!] })).text) });
    expect(second.text).toMatch(/Daily cancel limit reached: 2 of 2/);
    expect(h.chain.sent).toHaveLength(1);
  });

  it('refuses a bulk execute whose items exceed the trades left', async () => {
    const h = harness({ env: { OSWIKI_MAX_TRADES_PER_DAY: '1' } });
    const state = h.ctx.state;
    expect(() => state.check({ chainId: 1, trades: 2 }, { maxTrades: 1, maxCancels: 10, dailyMaxWei: { 1: null, 33139: null } })).toThrow(/this needs 2 more/);
  });
});

describe('gas and fee caps (M1)', () => {
  const approveTx = { chainId: 1 as const, to: WRAPPED_NATIVE[1]!, data: encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'approve', args: [SEAPORT_ADDRESS, ETH] }), value: 0n };

  function chainsWith(env: Record<string, string>, estimate: bigint, tracker?: PendingTracker) {
    const state = newChainState();
    const base = makeTransport(1, state, () => []);
    const transport = custom({
      async request(args: { method: string; params?: unknown }) {
        if (args.method === 'eth_estimateGas') return `0x${estimate.toString(16)}`;
        return base({ chain: mainnet }).request(args as never);
      },
    });
    const wallet = loadWallet({ OSWIKI_WALLET_KEY_FILE: testKeyFile() });
    const config = loadConfig(env);
    return { state, wallet, chains: createChains(config, wallet.account, { transportFor: () => transport, pollingInterval: 5, tracker }) };
  }

  it('classifies every allowed tx and caps its gas per kind', () => {
    expect(assertAllowedTx(approveTx, new Set())).toEqual({ kind: 'approve', orders: 1 });
    const setApproval = { chainId: 1 as const, to: COLLECTION, data: encodeFunctionData({ abi: NFT_ABI, functionName: 'setApprovalForAll', args: [OPENSEA_CONDUIT_ADDRESS, true] }), value: 0n };
    expect(assertAllowedTx(setApproval, new Set([COLLECTION]))).toEqual({ kind: 'setApprovalForAll', orders: 1 });
    expect(gasLimitCap(1, { kind: 'approve', orders: 1 })).toBe(100_000n);
    expect(gasLimitCap(1, { kind: 'setApprovalForAll', orders: 1 })).toBe(120_000n);
    expect(gasLimitCap(1, { kind: 'wrap', orders: 1 })).toBe(80_000n);
    expect(gasLimitCap(1, { kind: 'cancel', orders: 3 })).toBe(180_000n);
    expect(gasLimitCap(1, { kind: 'buy', orders: 2 })).toBe(600_000n);
    expect(gasLimitCap(1, { kind: 'accept', orders: 1 })).toBe(400_000n);
    expect(gasLimitCap(33139, { kind: 'approve', orders: 1 })).toBe(200_000n);
  });

  it('refuses a gas estimate above the cap for its kind', async () => {
    const { state, wallet, chains } = chainsWith({}, 150_000n);
    await expect(sendGuardedTx(chains, wallet.account, approveTx, new Set())).rejects.toThrow(/gas estimate of 150000 is above the approve limit of 100000/);
    expect(state.sent).toHaveLength(0);
  });

  it('refuses when the network fee is above OSWIKI_MAX_GWEI and sends capped fees otherwise', async () => {
    const low = chainsWith({ OSWIKI_MAX_GWEI: '1' }, 50_000n);
    await expect(sendGuardedTx(low.chains, low.wallet.account, approveTx, new Set())).rejects.toThrow(TxRefusedError);
    await expect(sendGuardedTx(low.chains, low.wallet.account, approveTx, new Set())).rejects.toThrow(/above the limit of 1 gwei \(OSWIKI_MAX_GWEI\)/);
    expect(low.state.sent).toHaveLength(0);
    const ok = chainsWith({}, 50_000n);
    await sendGuardedTx(ok.chains, ok.wallet.account, approveTx, new Set());
    expect(ok.state.sent).toHaveLength(1);
  });

  it('shows the network fee ceiling in previews', async () => {
    const h = harness();
    setupBuy(h);
    const text = await previewBuy(h);
    expect(text).toMatch(/Network fee: about .* now, at most 0\.09 ETH \(gas limit caps x 200 gwei, OSWIKI_MAX_GWEI\)/);
    const fee = await networkFee(h.ctx.chains, 1, [{ shape: { kind: 'approve', orders: 1 } }, { shape: { kind: 'wrap', orders: 1 } }]);
    expect(fee.maxWei).toBe(180_000n * 200n * 10n ** 9n);
    expect((await networkFee(h.ctx.chains, 1, [])).text).toMatch(/none/);
  });

  it('warns in the preview when gas is already above the cap', async () => {
    const h = harness({ env: { OSWIKI_MAX_GWEI: '0.5' } });
    setupBuy(h);
    expect(await previewBuy(h)).toMatch(/execute will refuse until it drops/);
  });
});

describe('pending transactions (L8)', () => {
  function tracked(h: Harness) {
    (h.ctx.chains as { tracker?: PendingTracker }).tracker = h.ctx.state;
  }

  const stuck = (sentAt: number, nonce = 0): PendingTx => ({ chainId: 1, hash: `0x${'ab'.repeat(32)}`, nonce, label: 'buy', sentAt });

  it('tracks a sent tx until its receipt arrives', async () => {
    const h = harness({ logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
    tracked(h);
    const seen: string[] = [];
    const tracker = h.ctx.state;
    (h.ctx.chains as { tracker?: PendingTracker }).tracker = {
      pendingTxs: chainId => tracker.pendingTxs(chainId),
      addPending: (entry) => { seen.push(`add ${entry.label} ${entry.nonce}`); tracker.addPending(entry); },
      removePending: (hash) => { seen.push('remove'); tracker.removePending(hash); },
    };
    setupBuy(h);
    expect((await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) })).isError).toBe(false);
    expect(seen).toEqual(['add buy 0', 'remove']);
    expect(h.ctx.state.pendingTxs()).toEqual([]);
  });

  it('refuses to send while an unconfirmed tx may still land, and clears it later', async () => {
    const h = harness({ logsFor: () => [fulfilledLog(vectorHash, OTHER_SELLER)] });
    tracked(h);
    setupBuy(h);
    h.ctx.state.addPending(stuck(NOW));
    const blocked = await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/still pending on Ethereum/);
    expect(h.chain.sent).toHaveLength(0);
    expect((await h.call('wallet_status')).text).toContain(`pending transactions: buy 0x${'ab'.repeat(32)}`);
    h.setNow(NOW + 31 * 60_000);
    expect((await h.call('execute', { confirmId: confirmIdOf(await previewBuy(h)) })).isError).toBe(false);
    expect(h.ctx.state.pendingTxs()).toEqual([]);
  });

  it('clears a tx once mined or once its nonce was used, and blocks while the node knows it', async () => {
    const entry = stuck(NOW, 3);
    const store: PendingTx[] = [entry];
    const tracker: PendingTracker = { pendingTxs: () => store, addPending: () => undefined, removePending: (hash) => { store.splice(store.findIndex(item => item.hash === hash), 1); } };
    const answers: Record<string, unknown> = { eth_getTransactionReceipt: null, eth_getTransactionByHash: null, eth_getTransactionCount: '0x3' };
    const wallet = loadWallet({ OSWIKI_WALLET_KEY_FILE: testKeyFile() });
    const transport = custom({ async request({ method }: { method: string }) { return answers[method] ?? null; } });
    const chains = createChains(loadConfig({}), wallet.account, { transportFor: () => transport, tracker });
    await expect(assertNoPendingTx(chains, wallet.account, 1, () => NOW)).rejects.toThrow(PendingTxError);
    answers.eth_getTransactionByHash = { hash: entry.hash, nonce: '0x3', blockHash: null, blockNumber: null, from: TEST_ADDRESS, to: SEAPORT_ADDRESS, value: '0x0', gas: '0x1', input: '0x', type: '0x2', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', chainId: '0x1', v: '0x0', r: '0x1', s: '0x1', yParity: '0x0', accessList: [], transactionIndex: null };
    await expect(assertNoPendingTx(chains, wallet.account, 1, () => NOW + 60 * 60_000)).rejects.toThrow(PendingTxError);
    answers.eth_getTransactionByHash = null;
    answers.eth_getTransactionCount = '0x4';
    await assertNoPendingTx(chains, wallet.account, 1, () => NOW);
    expect(store).toHaveLength(0);
  });
});

describe('state file (L7)', () => {
  const key = (byte: number) => new Uint8Array(32).fill(byte);
  const limits = { maxTrades: 10, maxCancels: 10, dailyMaxWei: { 1: 10n * ETH, 33139: null } };

  it('treats every cap as used when the file was edited, and survives a deletion in-process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-state-'));
    const state = new TradeState(dir, 10, () => NOW, { macKey: key(1) });
    state.record({ chainId: 1, trades: 3, spendWei: 2n * ETH }, limits);
    expect(state.tradesToday()).toBe(3);
    const file = join(dir, 'state.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.mac).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(file, JSON.stringify({ ...raw, trades: 0, spent: { 1: '0', 33139: '0' } }));
    expect(state.isTampered()).toBe(true);
    expect(() => state.check({ chainId: 1, cancels: 1 }, limits)).toThrow(/integrity check/);
    expect(() => state.record({ chainId: 1, trades: 1 }, limits)).toThrow(/integrity check/);

    const fresh = mkdtempSync(join(tmpdir(), 'oswiki-state-'));
    const other = new TradeState(fresh, 10, () => NOW, { macKey: key(1) });
    other.record({ chainId: 1, trades: 4 }, limits);
    writeFileSync(join(fresh, 'state.json'), readFileSync(join(fresh, 'state.json'), 'utf8'));
    expect(new TradeState(fresh, 10, () => NOW, { macKey: key(2) }).isTampered()).toBe(true);
    expect(new TradeState(fresh, 10, () => NOW, { macKey: key(1) }).tradesToday()).toBe(4);
    writeFileSync(join(fresh, 'state.json'), '');
    expect(other.remaining()).toBe(0);
  });

  it('keeps its own bookings when the file is deleted mid-session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-state-'));
    const state = new TradeState(dir, 5, () => NOW, { macKey: key(1) });
    state.record({ chainId: 1, trades: 5 }, { ...limits, maxTrades: 5 });
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'state.json'));
    expect(state.tradesToday()).toBe(5);
    expect(() => state.record({ chainId: 1, trades: 1 }, { ...limits, maxTrades: 5 })).toThrow(/Daily trade limit/);
  });

  it('writes atomically and removes a stale lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-state-'));
    const state = new TradeState(dir, 10, () => NOW, { macKey: key(1) });
    writeFileSync(join(dir, 'state.lock'), 'old');
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(join(dir, 'state.lock'), old, old);
    state.record({ chainId: 1, trades: 1 }, limits);
    expect(state.tradesToday()).toBe(1);
    expect(existsSync(join(dir, 'state.lock'))).toBe(false);
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('waits for a held lock and gives up without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-state-'));
    const state = new TradeState(dir, 10, () => NOW, { macKey: key(1) });
    writeFileSync(join(dir, 'state.lock'), 'busy');
    expect(() => state.record({ chainId: 1, trades: 1 }, limits)).toThrow(StateLockError);
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
  });

  it('keeps pending txs MAC-protected and across days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-state-'));
    let now = NOW;
    const state = new TradeState(dir, 10, () => now, { macKey: key(1) });
    state.addPending({ chainId: 33139, hash: `0x${'CD'.repeat(32)}` as Hex, nonce: 7, label: 'cancel', sentAt: NOW });
    now += 2 * 86_400_000;
    expect(state.pendingTxs(33139)).toEqual([{ chainId: 33139, hash: `0x${'cd'.repeat(32)}`, nonce: 7, label: 'cancel', sentAt: NOW }]);
    expect(state.pendingTxs(1)).toEqual([]);
    state.removePending(`0x${'CD'.repeat(32)}`);
    expect(state.pendingTxs()).toEqual([]);
  });
});

describe('key file (H4)', () => {
  function keyFile(content: string, mode = 0o600): string {
    const dir = mkdtempSync(join(tmpdir(), 'oswiki-key-'));
    const path = join(dir, 'key');
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  }

  it('reads the key from OSWIKI_WALLET_KEY_FILE and removes both variables', () => {
    const env: NodeJS.ProcessEnv = { OSWIKI_WALLET_KEY_FILE: keyFile(`﻿${TEST_KEY}\n`) };
    const wallet = loadWallet(env, 'win32');
    expect(wallet.account.address.toLowerCase()).toBe(TEST_ADDRESS);
    expect(env.OSWIKI_WALLET_KEY_FILE).toBeUndefined();
    expect(wallet.warnings).toEqual([expect.stringMatching(/cannot check who may read the key file.*%USERPROFILE%/)]);
    expect(wallet.stateKey).toHaveLength(32);
    expect(loadWallet({ OSWIKI_WALLET_KEY_FILE: testKeyFile() }).stateKey.equals(wallet.stateKey)).toBe(true);
  });

  it('warns about a key file other users can read on POSIX', () => {
    const path = keyFile(TEST_KEY, 0o644);
    expect(loadWallet({ OSWIKI_WALLET_KEY_FILE: path }, 'linux').warnings[0]).toMatch(/readable by other users .*chmod 600/);
    expect(loadWallet({ OSWIKI_WALLET_KEY_FILE: path }, 'win32').warnings).toEqual([expect.stringMatching(/Windows/)]);  });

  it('refuses both sources, a missing file, a huge file and bad content without echoing it', () => {
    expect(() => loadWallet({ OSWIKI_WALLET_KEY: TEST_KEY, OSWIKI_WALLET_KEY_FILE: keyFile(TEST_KEY) })).toThrow(INLINE_KEY_MESSAGE);
    expect(() => loadWallet({ OSWIKI_WALLET_KEY_FILE: join(tmpdir(), 'oswiki-missing-key') })).toThrow(/could not be opened/);
    expect(() => loadWallet({ OSWIKI_WALLET_KEY_FILE: keyFile('a'.repeat(5000)) })).toThrow(/too large/);
    const bad = `${TEST_KEY}ff`;
    try {
      loadWallet({ OSWIKI_WALLET_KEY_FILE: keyFile(bad) });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/OSWIKI_WALLET_KEY_FILE does not hold a valid private key/);
      expect((err as Error).message).not.toContain(bad.slice(2, 40));
    }
  });
});
