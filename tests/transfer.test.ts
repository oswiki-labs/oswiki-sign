import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { custom, decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256, parseTransaction, toFunctionSelector, type Address, type Hex } from 'viem';
import { namehash } from 'viem/ens';
import { describe, expect, it } from 'vitest';

import { NFT_ABI, WRAPPED_NATIVE_ABI } from '../src/abi.js';
import { ApiClient } from '../src/api.js';
import { assertAllowedTx, createChains, gasLimitCap, TxRefusedError } from '../src/chain.js';
import { loadConfig, type ConfirmMode } from '../src/config.js';
import { WRAPPED_NATIVE, type SupportedChainId } from '../src/constants.js';
import type { Ctx } from '../src/flows/common.js';
import { loadWallet } from '../src/secret.js';
import { createToolHandler, NO_HUMAN_CONFIRMER, serverInstructions, toolDefinitions, type HumanConfirmer } from '../src/server.js';
import { SettingsStore } from '../src/settings.js';
import { TradeState } from '../src/state.js';
import { ENS_REGISTRY_ABI, ENS_REGISTRY_ADDRESS, ENS_RESOLVER_ABI, ERC1155_TRANSFER_ABI, ERC721_SAFE_TRANSFER_ABI, NFT_TRANSFER_ABI, WRAPPED_TRANSFER_ABI } from '../src/transfer-abi.js';
import { confirmIdOf, ETH, mockApi, RevertError, TEST_ADDRESS, TEST_KEY } from './helpers.js';

const NFT721 = '0x790b2cf29ed4f310bf7641f013c65d4560d28371' as Address;
const NFT1155 = '0x1111111111111111111111111111111111111155' as Address;
const OTHER1155 = '0x2222222222222222222222222222222222222255' as Address;
const FRIEND = '0x3333333333333333333333333333333333333333' as Address;
const SAFE = '0x4444444444444444444444444444444444444444' as Address;
const FRESH = '0x5555555555555555555555555555555555555555' as Address;
const RESOLVER = '0x6666666666666666666666666666666666666666' as Address;
const WETH = WRAPPED_NATIVE[1]!.toLowerCase() as Address;
const VALIDATOR_REVERT = toFunctionSelector('CreatorTokenTransferValidator__CallerMustBeWhitelisted()') as Hex;

type Call = { to: string; fn: string; args: readonly unknown[] };

interface World {
  owners: Map<string, string>;
  balances1155: Map<string, bigint>;
  erc1155: Set<string>;
  nativeBalance: bigint;
  wrappedBalance: bigint;
  code: Map<string, Hex>;
  nonces: Map<string, number>;
  balances: Map<string, bigint>;
  forward: Map<string, Address>;
  reverse: Map<string, string>;
  revert: (call: Call, world: World) => Hex | null;
  sent: Array<{ chainId: number; to: Address; data: Hex; value: bigint }>;
  receipts: Map<string, unknown>;
}

function newWorld(): World {
  return {
    owners: new Map([[`${NFT721}:1`, TEST_ADDRESS], [`${NFT721}:2`, TEST_ADDRESS]]),
    balances1155: new Map([[`${NFT1155}:7`, 5n], [`${NFT1155}:8`, 2n], [`${OTHER1155}:3`, 1n]]),
    erc1155: new Set([NFT1155, OTHER1155]),
    nativeBalance: 10n * ETH,
    wrappedBalance: 5n * ETH,
    code: new Map([[SAFE, '0x6080604052' as Hex], [NFT721, '0x60' as Hex], [NFT1155, '0x60' as Hex], [OTHER1155, '0x60' as Hex]]),
    nonces: new Map([[FRESH, 0]]),
    balances: new Map([[FRESH, 0n]]),
    forward: new Map([['friend.eth', FRIEND]]),
    reverse: new Map([[FRIEND, 'friend.eth']]),
    revert: () => null,
    sent: [],
    receipts: new Map(),
  };
}

const NFT_CALLS = [...NFT_ABI, ...NFT_TRANSFER_ABI];
const WRAPPED_CALLS = [...WRAPPED_NATIVE_ABI, ...WRAPPED_TRANSFER_ABI];

function ensNodes(world: World): Map<string, { addr?: Address; name?: string }> {
  const nodes = new Map<string, { addr?: Address; name?: string }>();
  for (const [name, addr] of world.forward) nodes.set(namehash(name), { addr });
  for (const [addr, name] of world.reverse) nodes.set(namehash(`${addr.slice(2)}.addr.reverse`), { name });
  return nodes;
}

function ethCall(world: World, call: { to?: string; data?: Hex; value?: string }): Hex {
  const to = (call.to ?? '').toLowerCase();
  const data = call.data ?? '0x';
  if (data === '0x') return '0x';
  if (to === ENS_REGISTRY_ADDRESS) {
    const node = decodeFunctionData({ abi: ENS_REGISTRY_ABI, data }).args[0];
    return encodeFunctionResult({ abi: ENS_REGISTRY_ABI, functionName: 'resolver', result: ensNodes(world).has(node) ? RESOLVER : '0x0000000000000000000000000000000000000000' });
  }
  if (to === RESOLVER) {
    const decoded = decodeFunctionData({ abi: ENS_RESOLVER_ABI, data });
    const entry = ensNodes(world).get(decoded.args[0]);
    if (decoded.functionName === 'addr') return encodeFunctionResult({ abi: ENS_RESOLVER_ABI, functionName: 'addr', result: entry?.addr ?? '0x0000000000000000000000000000000000000000' });
    return encodeFunctionResult({ abi: ENS_RESOLVER_ABI, functionName: 'name', result: entry?.name ?? '' });
  }
  if (to === WETH) {
    const decoded = decodeFunctionData({ abi: WRAPPED_CALLS, data });
    if (decoded.functionName === 'balanceOf') return encodeFunctionResult({ abi: WRAPPED_NATIVE_ABI, functionName: 'balanceOf', result: world.wrappedBalance });
    const revert = world.revert({ to, fn: decoded.functionName, args: decoded.args ?? [] }, world);
    if (revert) throw new RevertError(revert);
    return decoded.functionName === 'transfer' ? encodeFunctionResult({ abi: WRAPPED_TRANSFER_ABI, functionName: 'transfer', result: true }) : '0x';
  }
  const decoded = decodeFunctionData({ abi: NFT_CALLS, data });
  switch (decoded.functionName) {
    case 'ownerOf': {
      const owner = world.owners.get(`${to}:${decoded.args[0]}`);
      if (!owner) throw new RevertError('0x7e273289');
      return encodeFunctionResult({ abi: NFT_ABI, functionName: 'ownerOf', result: owner as Address });
    }
    case 'balanceOf': return encodeFunctionResult({ abi: NFT_ABI, functionName: 'balanceOf', result: world.balances1155.get(`${to}:${decoded.args[1]}`) ?? 0n });
    case 'supportsInterface': return encodeFunctionResult({ abi: NFT_ABI, functionName: 'supportsInterface', result: world.erc1155.has(to) });
    case 'safeTransferFrom':
    case 'safeBatchTransferFrom': {
      const revert = world.revert({ to, fn: decoded.functionName, args: decoded.args }, world);
      if (revert) throw new RevertError(revert);
      return '0x';
    }
    default: return '0x';
  }
}

function transport(chainId: SupportedChainId, world: World) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[];
      const who = typeof p[0] === 'string' ? p[0].toLowerCase() : '';
      switch (method) {
        case 'eth_chainId': return `0x${chainId.toString(16)}`;
        case 'eth_blockNumber': return '0x10';
        case 'eth_getBalance': return `0x${(who === TEST_ADDRESS ? world.nativeBalance : world.balances.get(who) ?? ETH).toString(16)}`;
        case 'eth_getCode': return world.code.get(who) ?? '0x';
        case 'eth_gasPrice': return '0x3b9aca00';
        case 'eth_maxPriorityFeePerGas': return '0x1';
        case 'eth_estimateGas': {
          const tx = p[0] as { data?: Hex };
          return !tx.data || tx.data === '0x' ? '0x5208' : '0xafc8';
        }
        case 'eth_getTransactionCount': return `0x${(who === TEST_ADDRESS ? world.sent.length : world.nonces.get(who) ?? 3).toString(16)}`;
        case 'eth_getBlockByNumber': return { number: '0x10', hash: `0x${'33'.repeat(32)}`, baseFeePerGas: '0x3b9aca00', timestamp: '0x0', transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', parentHash: `0x${'44'.repeat(32)}` };
        case 'eth_sendRawTransaction': {
          const tx = parseTransaction(p[0] as Hex);
          const record = { chainId, to: tx.to!.toLowerCase() as Address, data: tx.data ?? '0x', value: tx.value ?? 0n };
          world.sent.push(record);
          const hash = keccak256(p[0] as Hex);
          world.receipts.set(hash, {
            status: '0x1', transactionHash: hash, blockNumber: '0x10', blockHash: `0x${'55'.repeat(32)}`, transactionIndex: '0x0', from: TEST_ADDRESS, to: record.to,
            cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, logsBloom: `0x${'00'.repeat(256)}`, type: '0x2', logs: [],
          });
          return hash;
        }
        case 'eth_getTransactionReceipt': return world.receipts.get(p[0] as string) ?? null;
        case 'eth_getTransactionByHash': return null;
        case 'eth_call': return ethCall(world, p[0] as { to?: string; data?: Hex });
        default: throw new Error(`unmocked ${method}`);
      }
    },
  });
}

function recorder(decision: 'confirmed' | 'declined' = 'confirmed'): HumanConfirmer & { asked: Array<{ message: string; title?: string }> } {
  const asked: Array<{ message: string; title?: string }> = [];
  return { asked, available: () => true, ask: async (message, title) => { asked.push({ message, title }); return decision; } };
}

function setup(options: { env?: Record<string, string>; confirmer?: HumanConfirmer } = {}) {
  const env: NodeJS.ProcessEnv = {
    OSWIKI_WALLET_KEY: TEST_KEY,
    OSWIKI_SIGN_STATE_DIR: mkdtempSync(join(tmpdir(), 'oswiki-sign-transfer-')),
    OSWIKI_MAX_BUY_ETH: '1000',
    OSWIKI_MAX_BUY_APE: '100000',
    ...options.env,
  };
  const wallet = loadWallet(env);
  const settings = SettingsStore.fromEnv(env, wallet.stateKey);
  const config = settings.load();
  const world = newWorld();
  const api = mockApi();
  const now = Date.parse('2026-10-10T12:00:00Z');
  const ctx: Ctx = {
    config,
    account: wallet.account,
    api: new ApiClient({ apiKey: null, fetch: api.fetch, base: 'https://api.test' }),
    chains: createChains(config, wallet.account, { transportFor: chainId => transport(chainId, world), pollingInterval: 5 }),
    state: new TradeState(config.stateDir, config.maxTradesPerDay, () => now),
    now: () => now,
  };
  const confirmer = options.confirmer ?? recorder();
  const handler = createToolHandler(ctx, wallet.scrub, { confirmer, settings });
  const call = async (name: string, args: unknown = {}) => {
    const result = await handler(name, args);
    return { text: result.content.map(entry => entry.text).join('\n'), isError: result.isError === true };
  };
  return { ctx, world, api, handler, call, confirmer, stateDir: config.stateDir as string };
}

async function previewOk(h: ReturnType<typeof setup>, args: unknown): Promise<string> {
  const preview = await h.call('preview_transfer', args);
  expect(preview.isError, preview.text).toBe(false);
  return preview.text;
}

describe('sending NFTs needs the user\'s dialog approval', () => {
  it('sends one ERC-721 after the dialog, which shows the chain, item and full recipient', async () => {
    const confirmer = recorder();
    const h = setup({ confirmer });
    const text = await previewOk(h, { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }] });
    expect(text).toContain(`Recipient: ${FRIEND}`);
    expect(text).toContain('ENS name of this address: friend.eth');
    expect(text).toMatch(/on Ethereum/);
    expect(text).toMatch(/approve this send in its own dialog \(always/);
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/Sent to 0x3333.*\(friend\.eth\)/);
    expect(confirmer.asked).toHaveLength(1);
    expect(confirmer.asked[0]!.message).toContain(FRIEND);
    expect(confirmer.asked[0]!.message).toContain(`${NFT721} #1`);
    expect(confirmer.asked[0]!.title).toMatch(/Send/);
    expect(h.world.sent).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: ERC721_SAFE_TRANSFER_ABI, data: h.world.sent[0]!.data });
    expect(decoded.args.map(arg => String(arg).toLowerCase())).toEqual([TEST_ADDRESS, FRIEND, '1']);
    expect(h.world.sent[0]!.to).toBe(NFT721);
    expect(h.ctx.state.tradesToday()).toBe(1);
  });

  for (const mode of ['off', 'ai'] as ConfirmMode[]) {
    it(`asks in the dialog even with OSWIKI_CONFIRM_MODE=${mode}`, async () => {
      const confirmer = recorder();
      const h = setup({ env: { OSWIKI_CONFIRM_MODE: mode }, confirmer });
      const text = await previewOk(h, { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }] });
      expect(text).not.toMatch(/Confirmation is off/);
      expect((await h.call('execute', { confirmId: confirmIdOf(text) })).isError).toBe(false);
      expect(confirmer.asked).toHaveLength(1);
      expect(h.world.sent).toHaveLength(1);
    });

    it(`refuses without a dialog even with OSWIKI_CONFIRM_MODE=${mode}`, async () => {
      const h = setup({ env: { OSWIKI_CONFIRM_MODE: mode }, confirmer: NO_HUMAN_CONFIRMER });
      const preview = await h.call('preview_transfer', { chainId: 1, to: FRIEND, nativeAmount: '0.1' });
      expect(preview.isError).toBe(true);
      expect(preview.text).toMatch(/needs your approval in oswiki-sign's own dialog, and this MCP client cannot show it/);
      expect(h.world.sent).toHaveLength(0);
    });
  }

  it('refuses at execute when the dialog went away after the preview', async () => {
    const h = setup({ env: { OSWIKI_CONFIRM_MODE: 'off' } });
    const text = await previewOk(h, { chainId: 1, to: FRIEND, nativeAmount: '0.1' });
    h.handler.confirmer = NO_HUMAN_CONFIRMER;
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot show it/);
    expect(h.world.sent).toHaveLength(0);
    expect(h.ctx.state.sentToday(1)).toBe(0n);
  });

  it('a declined dialog sends nothing and books nothing', async () => {
    const h = setup({ confirmer: recorder('declined') });
    const text = await previewOk(h, { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }], nativeAmount: '1' });
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/did not approve the send/);
    expect(h.world.sent).toHaveLength(0);
    expect(h.ctx.state.tradesToday()).toBe(0);
    expect(h.ctx.state.sentToday(1)).toBe(0n);
  });

  it('tells the AI that sending always needs the dialog and an explicit recipient', () => {
    for (const mode of ['human', 'ai', 'off'] as ConfirmMode[]) {
      expect(serverInstructions(mode)).toMatch(/ALWAYS needs the user's own approval in oswiki-sign's dialog, in every confirmation mode/);
      expect(serverInstructions(mode)).toMatch(/the user gave you explicitly/);
      const tool = toolDefinitions(mode).find(entry => entry.name === 'preview_transfer')!;
      expect(tool.description).toMatch(/ALWAYS approves the send/);
      expect(tool.description).toMatch(/never pick or look one up yourself/);
    }
  });
});

describe('what can be sent', () => {
  it('refuses tokens this wallet does not hold, per item', async () => {
    const h = setup();
    const result = await h.call('preview_transfer', { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }, { contract: NFT721, tokenId: '9' }, { contract: NFT1155, tokenId: '8', amount: 3 }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${NFT721} #9: could not read its owner`);
    expect(result.text).toContain(`${NFT1155} #8 x3: this wallet holds 2, not 3`);
    expect(result.text).not.toContain(`${NFT721} #1:`);
    h.world.owners.set(`${NFT721}:9`, FRIEND);
    expect((await h.call('preview_transfer', { chainId: 1, to: SAFE, items: [{ contract: NFT721, tokenId: '9' }] })).text).toContain(`${NFT721} #9: this wallet does not own it`);
  });

  it('groups ERC-1155 ids per contract into one batch, singles and 721s go one by one', async () => {
    const h = setup();
    const text = await previewOk(h, {
      chainId: 1,
      to: FRIEND,
      items: [{ contract: NFT1155, tokenId: '7', amount: 2 }, { contract: NFT721, tokenId: '1' }, { contract: NFT1155, tokenId: '8', amount: 1 }, { contract: OTHER1155, tokenId: '3' }, { contract: NFT721, tokenId: '2' }],
    });
    expect(text).toMatch(/Transactions \(4/);
    expect((await h.call('execute', { confirmId: confirmIdOf(text) })).isError).toBe(false);
    expect(h.world.sent).toHaveLength(4);
    const batch = h.world.sent.find(tx => tx.to === NFT1155)!;
    const decoded = decodeFunctionData({ abi: ERC1155_TRANSFER_ABI, data: batch.data });
    expect(decoded.functionName).toBe('safeBatchTransferFrom');
    expect(decoded.args[2]).toEqual([7n, 8n]);
    expect(decoded.args[3]).toEqual([2n, 1n]);
    const single = decodeFunctionData({ abi: ERC1155_TRANSFER_ABI, data: h.world.sent.find(tx => tx.to === OTHER1155)!.data });
    expect(single.functionName).toBe('safeTransferFrom');
    expect(h.world.sent.filter(tx => tx.to === NFT721)).toHaveLength(2);
    expect(h.ctx.state.tradesToday()).toBe(5);
  });

  it('refuses ERC-721 amounts above 1 and duplicates', async () => {
    const h = setup();
    expect((await h.call('preview_transfer', { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1', amount: 2 }] })).text).toMatch(/ERC-721 collection/);
    expect((await h.call('preview_transfer', { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }, { contract: NFT721, tokenId: '1' }] })).text).toMatch(/listed twice/);
  });

  it('reports a collection that blocks direct transfers per item, and finds the failing id in a batch', async () => {
    const h = setup();
    h.world.revert = call => (call.to === NFT721 && call.args[2] === 2n ? VALIDATOR_REVERT : null);
    const result = await h.call('preview_transfer', { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }, { contract: NFT721, tokenId: '2' }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${NFT721} #2: this collection doesn't allow direct transfers`);
    expect(result.text).not.toContain(`${NFT721} #1:`);

    h.world.revert = (call) => {
      if (call.to !== NFT1155) return null;
      const ids = call.fn === 'safeBatchTransferFrom' ? call.args[2] as bigint[] : [call.args[2] as bigint];
      return ids.includes(8n) ? '0x08c379a0' as Hex : null;
    };
    const batch = await h.call('preview_transfer', { chainId: 1, to: SAFE, items: [{ contract: NFT1155, tokenId: '7' }, { contract: NFT1155, tokenId: '8' }] });
    expect(batch.isError).toBe(true);
    expect(batch.text).toContain(`${NFT1155} #8 x1: the transfer reverts in simulation`);
    expect(batch.text).toMatch(/recipient contract does not accept NFTs/);
    expect(batch.text).not.toContain(`${NFT1155} #7 x1:`);
    expect(h.world.sent).toHaveLength(0);
  });

  it('applies the blocked and allowed collection lists to sends', async () => {
    const h = setup({ env: { OSWIKI_BLOCKED_COLLECTIONS: NFT721 } });
    const result = await h.call('preview_transfer', { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${NFT721} #1: the collection is blocked (OSWIKI_BLOCKED_COLLECTIONS)`);
    const allow = setup({ env: { OSWIKI_ALLOWED_COLLECTIONS: NFT1155 } });
    expect((await allow.call('preview_transfer', { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }] })).text).toMatch(/not in OSWIKI_ALLOWED_COLLECTIONS/);
  });

  it('counts each sent NFT toward OSWIKI_MAX_TRADES_PER_DAY', async () => {
    const h = setup({ env: { OSWIKI_MAX_TRADES_PER_DAY: '1' } });
    const result = await h.call('preview_transfer', { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }, { contract: NFT721, tokenId: '2' }] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Daily trade limit reached/);
  });

  it('reports exactly what was sent when a later transfer fails', async () => {
    const h = setup();
    const text = await previewOk(h, { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }, { contract: NFT721, tokenId: '2' }] });
    h.world.revert = (call, world) => (world.sent.length >= 1 && call.args[2] === 2n ? VALIDATOR_REVERT : null);
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Partly sent to 0x3333/);
    expect(result.text).toMatch(/#1: sent, transaction 0x[0-9a-f]{64} confirmed/);
    expect(result.text).toMatch(/#2: FAILED \(Simulation failed/);
    expect(h.world.sent).toHaveLength(1);
  });
});

describe('recipient safety', () => {
  it('refuses the zero and burn addresses, the token contract, the WETH contract and this wallet', async () => {
    const h = setup();
    const refuse = async (to: string, args: Record<string, unknown>, pattern: RegExp) => {
      const result = await h.call('preview_transfer', { chainId: 1, to, ...args });
      expect(result.isError, to).toBe(true);
      expect(result.text, to).toMatch(pattern);
    };
    await refuse('0x0000000000000000000000000000000000000000', { nativeAmount: '1' }, /zero or a burn address/);
    await refuse('0x000000000000000000000000000000000000dEaD', { items: [{ contract: NFT721, tokenId: '1' }] }, /zero or a burn address/);
    await refuse(NFT721, { items: [{ contract: NFT721, tokenId: '1' }] }, /the NFT contract itself/);
    await refuse(WETH, { wrappedAmount: '1' }, /WETH token contract itself; to turn it into ETH use preview_unwrap/);
    await refuse(TEST_ADDRESS, { nativeAmount: '1' }, /this wallet itself/);
    await refuse('bob', { nativeAmount: '1' }, /full 0x address .* or an ENS name/);
    expect(h.world.sent).toHaveLength(0);
  });

  it('warns loudly about a contract recipient and notes a new recipient', async () => {
    const h = setup();
    const contract = await previewOk(h, { chainId: 1, to: SAFE, items: [{ contract: NFT721, tokenId: '1' }] });
    expect(contract).toMatch(/WARNING: the recipient is a CONTRACT on Ethereum/);
    expect(contract).toMatch(/No ENS name/);
    const fresh = await previewOk(h, { chainId: 1, to: FRESH, nativeAmount: '0.1' });
    expect(fresh).toMatch(/NOTE: new recipient/);
    expect(fresh).not.toMatch(/CONTRACT/);
  });

  it('resolves an ENS name on Ethereum and shows the resolved address', async () => {
    const h = setup();
    const text = await previewOk(h, { chainId: 33139, to: 'Friend.eth', items: [{ contract: NFT721, tokenId: '1' }] });
    expect(text).toContain(`Recipient: ${FRIEND}`);
    expect(text).toContain(`ENS: friend.eth resolves to ${FRIEND} on Ethereum right now`);
    expect(text).toMatch(/on ApeChain/);
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError, result.text).toBe(false);
    expect(decodeFunctionData({ abi: ERC721_SAFE_TRANSFER_ABI, data: h.world.sent[0]!.data }).args[1].toLowerCase()).toBe(FRIEND);
    expect(h.world.sent[0]!.chainId).toBe(33139);
    const unknown = await h.call('preview_transfer', { chainId: 1, to: 'nobody.eth', nativeAmount: '1' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/does not resolve to an address/);
  });

  it('shows a reverse ENS name only when it resolves back to the same address', async () => {
    const h = setup();
    h.world.forward.set('friend.eth', SAFE);
    const text = await previewOk(h, { chainId: 1, to: FRIEND, nativeAmount: '0.1' });
    expect(text).not.toContain('friend.eth');
    expect(text).toMatch(/No ENS name/);
  });
});

describe('sending funds', () => {
  it('sends ETH and WETH to the recipient and counts both toward the daily send limit', async () => {
    const h = setup({ env: { OSWIKI_DAILY_MAX_SEND_ETH: '2' } });
    const text = await previewOk(h, { chainId: 1, to: FRIEND, nativeAmount: '0.5', wrappedAmount: '1' });
    expect(text).toMatch(/1 WETH/);
    expect(text).toMatch(/0\.5 ETH/);
    expect(text).toMatch(/Sent today on Ethereum: 0 ETH of 2 ETH/);
    expect((await h.call('execute', { confirmId: confirmIdOf(text) })).isError).toBe(false);
    expect(h.world.sent).toHaveLength(2);
    const [erc20, value] = h.world.sent;
    expect(erc20!.to).toBe(WETH);
    expect(decodeFunctionData({ abi: WRAPPED_TRANSFER_ABI, data: erc20!.data }).args).toEqual([expect.stringMatching(/^0x3333/i), ETH]);
    expect(value).toMatchObject({ to: FRIEND, value: ETH / 2n, data: '0x' });
    expect(h.ctx.state.sentToday(1)).toBe(ETH + ETH / 2n);
    expect(h.ctx.state.tradesToday()).toBe(0);

    const over = await h.call('preview_transfer', { chainId: 1, to: FRIEND, nativeAmount: '0.6' });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/Daily send limit on Ethereum: 1\.5 ETH sent today plus 0\.6 ETH would exceed 2 ETH \(OSWIKI_DAILY_MAX_SEND_ETH/);

    const reread = new TradeState(h.stateDir, 50, () => Date.parse('2026-10-10T13:00:00Z'));
    expect(reread.isTampered()).toBe(false);
    expect(reread.sentToday(1)).toBe(ETH + ETH / 2n);
  });

  it('defaults the send limit to the daily buy limit and is off without one', () => {
    expect(loadConfig({ OSWIKI_MAX_BUY_ETH: '0.5' }).dailyMaxSendWei[1]).toBe(15n * 10n ** 17n);
    expect(loadConfig({ OSWIKI_DAILY_MAX_APE: '10', OSWIKI_DAILY_MAX_SEND_APE: '4' }).dailyMaxSendWei[33139]).toBe(4n * ETH);
    expect(loadConfig({}).dailyMaxSendWei[1]).toBeNull();
    expect(() => loadConfig({ OSWIKI_DAILY_MAX_SEND_ETH: 'lots' })).toThrow(/OSWIKI_DAILY_MAX_SEND_ETH/);
  });

  it('refuses funds when no send limit is set, but still sends NFTs', async () => {
    const h = setup({ env: { OSWIKI_MAX_BUY_ETH: '' } });
    const funds = await h.call('preview_transfer', { chainId: 1, to: FRIEND, nativeAmount: '0.1' });
    expect(funds.isError).toBe(true);
    expect(funds.text).toMatch(/Sending funds on Ethereum is off until a daily send limit is set \(OSWIKI_DAILY_MAX_SEND_ETH\)/);
    await previewOk(h, { chainId: 1, to: FRIEND, items: [{ contract: NFT721, tokenId: '1' }] });
  });

  it('refuses more than the wallet holds and amounts that are not positive', async () => {
    const h = setup();
    expect((await h.call('preview_transfer', { chainId: 1, to: FRIEND, wrappedAmount: '6' })).text).toMatch(/Not enough WETH/);
    expect((await h.call('preview_transfer', { chainId: 1, to: FRIEND, nativeAmount: '11' })).text).toMatch(/Not enough ETH/);
    expect((await h.call('preview_transfer', { chainId: 1, to: FRIEND, nativeAmount: '0' })).text).toMatch(/greater than 0/);
    expect((await h.call('preview_transfer', { chainId: 1, to: FRIEND })).text).toMatch(/Nothing to send/);
  });

  it('update_limits changes the send limits after the dialog', async () => {
    const confirmer = recorder();
    const h = setup({ confirmer });
    const result = await h.call('update_limits', { dailyMaxSendEth: '0.25', dailyMaxSendApe: '30' });
    expect(result.isError, result.text).toBe(false);
    expect(confirmer.asked[0]!.message).toMatch(/OSWIKI_DAILY_MAX_SEND_ETH: 3000 -> 0\.25/);
    expect(h.ctx.config.dailyMaxSendWei[1]).toBe(ETH / 4n);
    expect(h.ctx.config.dailyMaxSendWei[33139]).toBe(30n * ETH);
    expect((await h.call('wallet_status')).text).toMatch(/sent today \(native \+ wrapped.*0 ETH of 0\.25 ETH used/);
  });
});

describe('unwrap', () => {
  it('turns WETH into ETH with withdraw and follows the normal confirmation mode', async () => {
    const h = setup({ env: { OSWIKI_CONFIRM_MODE: 'ai' }, confirmer: NO_HUMAN_CONFIRMER });
    const text = (await h.call('preview_unwrap', { chainId: 1, amount: '1.5' })).text;
    expect(text).toMatch(/unwrap 1\.5 WETH into 1\.5 ETH/);
    expect(text).toMatch(/Nothing leaves the wallet/);
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError, result.text).toBe(false);
    expect(h.world.sent).toHaveLength(1);
    expect(h.world.sent[0]!.to).toBe(WETH);
    expect(decodeFunctionData({ abi: WRAPPED_TRANSFER_ABI, data: h.world.sent[0]!.data })).toMatchObject({ functionName: 'withdraw', args: [3n * ETH / 2n] });
    expect(h.ctx.state.sentToday(1)).toBe(0n);
  });

  it('asks in the dialog in human mode and refuses more than the balance', async () => {
    const confirmer = recorder('declined');
    const h = setup({ confirmer });
    expect((await h.call('preview_unwrap', { chainId: 1, amount: '9' })).text).toMatch(/Not enough WETH/);
    const text = (await h.call('preview_unwrap', { chainId: 1, amount: '1' })).text;
    const result = await h.call('execute', { confirmId: confirmIdOf(text) });
    expect(result.isError).toBe(true);
    expect(confirmer.asked[0]!.message).toMatch(/approve this trade/);
    expect(h.world.sent).toHaveLength(0);
  });
});

describe('transaction allowlist for sends', () => {
  const target = { from: TEST_ADDRESS, to: FRIEND };
  const nft = new Set([NFT721]);

  it('allows transfers only to the approved recipient and from this wallet', () => {
    const to721 = (from: Address, to: Address) => ({ chainId: 1 as const, to: NFT721, value: 0n, data: encodeFunctionData({ abi: ERC721_SAFE_TRANSFER_ABI, functionName: 'safeTransferFrom', args: [from, to, 1n] }) });
    expect(assertAllowedTx(to721(TEST_ADDRESS, FRIEND), nft, target)).toEqual({ kind: 'transfer721', orders: 1 });
    expect(() => assertAllowedTx(to721(TEST_ADDRESS, SAFE), nft, target)).toThrow(TxRefusedError);
    expect(() => assertAllowedTx(to721(FRIEND, FRIEND), nft, target)).toThrow(/from another wallet/);
    expect(() => assertAllowedTx(to721(TEST_ADDRESS, FRIEND), nft)).toThrow(TxRefusedError);
    const erc20 = (to: Address) => ({ chainId: 1 as const, to: WETH, value: 0n, data: encodeFunctionData({ abi: WRAPPED_TRANSFER_ABI, functionName: 'transfer', args: [to, 1n] }) });
    expect(assertAllowedTx(erc20(FRIEND), nft, target).kind).toBe('erc20Transfer');
    expect(() => assertAllowedTx(erc20(SAFE), nft, target)).toThrow(/not the approved recipient/);
    expect(() => assertAllowedTx(erc20(FRIEND), nft)).toThrow(TxRefusedError);
    expect(assertAllowedTx({ chainId: 1, to: FRIEND, value: 1n, data: '0x' }, nft, target).kind).toBe('send');
    expect(() => assertAllowedTx({ chainId: 1, to: SAFE, value: 1n, data: '0x' }, nft, target)).toThrow(TxRefusedError);
    const batch = encodeFunctionData({ abi: ERC1155_TRANSFER_ABI, functionName: 'safeBatchTransferFrom', args: [TEST_ADDRESS, FRIEND, [1n, 2n, 3n], [1n, 1n, 1n], '0x'] });
    expect(assertAllowedTx({ chainId: 1, to: NFT721, value: 0n, data: batch }, nft, target)).toEqual({ kind: 'transfer1155Batch', orders: 3 });
    expect(assertAllowedTx({ chainId: 1, to: WETH, value: 0n, data: encodeFunctionData({ abi: WRAPPED_TRANSFER_ABI, functionName: 'withdraw', args: [1n] }) }, nft).kind).toBe('unwrap');
  });

  it('caps gas per transfer kind', () => {
    expect(gasLimitCap(1, { kind: 'send', orders: 1 })).toBe(21_000n);
    expect(gasLimitCap(33139, { kind: 'send', orders: 1 })).toBe(150_000n);
    expect(gasLimitCap(1, { kind: 'transfer721', orders: 1 })).toBe(90_000n);
    expect(gasLimitCap(1, { kind: 'transfer1155', orders: 1 })).toBe(80_000n);
    expect(gasLimitCap(1, { kind: 'transfer1155Batch', orders: 3 })).toBe(180_000n);
    expect(gasLimitCap(1, { kind: 'erc20Transfer', orders: 1 })).toBe(70_000n);
    expect(gasLimitCap(1, { kind: 'unwrap', orders: 1 })).toBe(50_000n);
    expect(gasLimitCap(33139, { kind: 'transfer721', orders: 1 })).toBe(180_000n);
  });
});
