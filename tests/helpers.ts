import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
} from 'viem';

import {
  FULFILL_ADVANCED_ORDER_ABI,
  FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI,
  FULFILL_BASIC_ORDER_ABI,
  MATCH_ADVANCED_ORDERS_ABI,
  NFT_ABI,
  SEAPORT_CANCEL_ABI,
  SEAPORT_EVENTS_ABI,
  SEAPORT_GET_COUNTER_ABI,
  WRAPPED_NATIVE_ABI,
} from '../src/abi.js';
import { ApiClient } from '../src/api.js';
import { createChains } from '../src/chain.js';
import { SettingsStore } from '../src/settings.js';
import { OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, WRAPPED_NATIVE, type SupportedChainId } from '../src/constants.js';
import type { Ctx } from '../src/flows/common.js';
import { loadWallet } from '../src/secret.js';
import { createToolHandler, type ToolHandler } from '../src/server.js';
import { TradeState } from '../src/state.js';

export const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const TEST_ADDRESS = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
export const COLLECTION = '0x790b2cf29ed4f310bf7641f013c65d4560d28371' as Address;
export const OTHER_SELLER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address;
export const ROYALTY_RECIPIENT = '0x000000000000000000000000000000000000dead';
export const MAINNET_FEE_RECIPIENT = '0x3a1d5441892ea68e7b0dc79ed849a0f5db0b1504';
export const ETH = 10n ** 18n;

const SEAPORT_CALLS_ABI = [...FULFILL_ADVANCED_ORDER_ABI, ...FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, ...FULFILL_BASIC_ORDER_ABI, ...MATCH_ADVANCED_ORDERS_ABI, ...SEAPORT_CANCEL_ABI, ...SEAPORT_GET_COUNTER_ABI];

export class RevertError extends Error {
  readonly data: Hex;
  constructor(data: Hex) {
    super('execution reverted');
    this.data = data;
  }
}

export interface ChainState {
  counters: Map<string, bigint>;
  counterFails: boolean;
  owners: Map<string, string>;
  balances1155: Map<string, bigint>;
  erc1155: Set<string>;
  approvals: Set<string>;
  nativeBalance: bigint;
  wrappedBalance: bigint;
  allowance: bigint;
  seaportRevert: Hex | null;
  available: boolean[] | null;
  sent: Array<{ chainId: number; to: Address; data: Hex; value: bigint }>;
  calls: Array<{ to: string; data: Hex; from?: string; value?: bigint }>;
  receipts: Map<string, unknown>;
}

export function newChainState(): ChainState {
  return {
    counters: new Map(),
    counterFails: false,
    owners: new Map(),
    balances1155: new Map(),
    erc1155: new Set(),
    approvals: new Set(),
    nativeBalance: 100n * ETH,
    wrappedBalance: 0n,
    allowance: 0n,
    seaportRevert: null,
    available: null,
    sent: [],
    calls: [],
    receipts: new Map(),
  };
}

function hexToBig(value: unknown): bigint {
  return typeof value === 'string' && value.startsWith('0x') ? BigInt(value) : 0n;
}

function log(eventName: 'OrderFulfilled' | 'OrderCancelled', args: Record<string, unknown>, index: number) {
  const event = SEAPORT_EVENTS_ABI.find(entry => entry.name === eventName)!;
  const topics = encodeEventTopics({ abi: [event], eventName, args: args as never });
  const nonIndexed = event.inputs.filter(input => !input.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map(input => args[input.name]) as never);
  return {
    address: SEAPORT_ADDRESS,
    topics,
    data,
    blockNumber: '0x1',
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: '0x0',
    logIndex: `0x${index.toString(16)}`,
    removed: false,
  };
}

/** Seaport events for a sent tx: every cancelled order, every filled order (by struct hash supplied by the test). */
export type LogsFor = (tx: { to: Address; data: Hex; value: bigint }) => Array<ReturnType<typeof log>>;

export function cancelLogs(orderHashes: Hex[], offerer: Address) {
  return orderHashes.map((orderHash, i) => log('OrderCancelled', { orderHash, offerer, zone: '0x0000000000000000000000000000000000000000' }, i));
}

export function fulfilledLog(orderHash: Hex, offerer: Address, considerationNft?: { token: Address; identifier: bigint }) {
  return log('OrderFulfilled', {
    orderHash,
    offerer,
    zone: '0x0000000000000000000000000000000000000000',
    recipient: TEST_ADDRESS,
    offer: [],
    consideration: considerationNft ? [{ itemType: 2, token: considerationNft.token, identifier: considerationNft.identifier, amount: 1n, recipient: offerer }] : [],
  }, 0);
}

/** A listing fill as Seaport logs it: the NFT units delivered and the native amount paid to the seller. */
export function boughtLog(orderHash: Hex, offerer: Address, nft: { token: Address; identifier: bigint; amount: bigint }, paidWei: bigint) {
  return log('OrderFulfilled', {
    orderHash,
    offerer,
    zone: '0x0000000000000000000000000000000000000000',
    recipient: TEST_ADDRESS,
    offer: [{ itemType: 3, token: nft.token, identifier: nft.identifier, amount: nft.amount }],
    consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifier: 0n, amount: paidWei, recipient: offerer }],
  }, 0);
}

export function makeTransport(chainId: SupportedChainId, state: ChainState, logsFor: LogsFor) {
  const receipts = state.receipts;
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case 'eth_chainId': return `0x${chainId.toString(16)}`;
        case 'eth_blockNumber': return '0x10';
        case 'eth_getBalance': return `0x${state.nativeBalance.toString(16)}`;
        case 'eth_gasPrice': return '0x3b9aca00';
        case 'eth_maxPriorityFeePerGas': return '0x1';
        case 'eth_estimateGas': return '0xc350';
        case 'eth_getTransactionCount': return `0x${state.sent.length.toString(16)}`;
        case 'eth_getBlockByNumber': return { number: '0x10', hash: `0x${'33'.repeat(32)}`, baseFeePerGas: '0x3b9aca00', timestamp: '0x0', transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', parentHash: `0x${'44'.repeat(32)}` };
        case 'eth_sendRawTransaction': {
          const tx = parseTransaction(p[0] as Hex);
          const record = { chainId, to: tx.to!.toLowerCase() as Address, data: tx.data ?? '0x', value: tx.value ?? 0n };
          state.sent.push(record);
          const hash = keccak256(p[0] as Hex);
          receipts.set(hash, {
            status: '0x1',
            transactionHash: hash,
            blockNumber: '0x10',
            blockHash: `0x${'55'.repeat(32)}`,
            transactionIndex: '0x0',
            from: TEST_ADDRESS,
            to: record.to,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x1',
            contractAddress: null,
            logsBloom: `0x${'00'.repeat(256)}`,
            type: '0x2',
            logs: logsFor(record),
          });
          return hash;
        }
        case 'eth_getTransactionReceipt': return receipts.get(p[0] as string) ?? null;
        case 'eth_getTransactionByHash': return null;
        case 'eth_call': return ethCall(state, p[0] as { to: string; data: Hex; from?: string; value?: string });
        default: throw new Error(`unmocked ${method}`);
      }
    },
  });
}

function ethCall(state: ChainState, call: { to: string; data: Hex; from?: string; value?: string }): Hex {
  const to = call.to.toLowerCase();
  state.calls.push({ to, data: call.data, from: call.from?.toLowerCase(), value: hexToBig(call.value) });
  if (to === SEAPORT_ADDRESS) {
    const decoded = decodeFunctionData({ abi: SEAPORT_CALLS_ABI, data: call.data.endsWith('da32920a') ? call.data.slice(0, -8) as Hex : call.data });
    if (decoded.functionName === 'getCounter') {
      if (state.counterFails) throw new Error('rpc down');
      return encodeFunctionResult({ abi: SEAPORT_GET_COUNTER_ABI, functionName: 'getCounter', result: state.counters.get((decoded.args[0] as string).toLowerCase()) ?? 0n });
    }
    if (state.seaportRevert) throw new RevertError(state.seaportRevert);
    if (decoded.functionName === 'fulfillAvailableAdvancedOrders') {
      const count = (decoded.args[0] as unknown[]).length;
      return encodeFunctionResult({ abi: FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, functionName: 'fulfillAvailableAdvancedOrders', result: [state.available ?? Array(count).fill(true), []] });
    }
    return '0x';
  }
  const wrappedTokens = Object.values(WRAPPED_NATIVE).map(address => address.toLowerCase());
  if (wrappedTokens.includes(to)) {
    const decoded = decodeFunctionData({ abi: WRAPPED_NATIVE_ABI, data: call.data });
    if (decoded.functionName === 'balanceOf') return encodeFunctionResult({ abi: WRAPPED_NATIVE_ABI, functionName: 'balanceOf', result: state.wrappedBalance });
    if (decoded.functionName === 'allowance') return encodeFunctionResult({ abi: WRAPPED_NATIVE_ABI, functionName: 'allowance', result: state.allowance });
    return '0x';
  }
  const decoded = decodeFunctionData({ abi: NFT_ABI, data: call.data });
  switch (decoded.functionName) {
    case 'ownerOf': {
      const owner = state.owners.get(`${to}:${decoded.args[0]}`);
      if (!owner) throw new RevertError('0x7e273289');
      return encodeFunctionResult({ abi: NFT_ABI, functionName: 'ownerOf', result: owner as Address });
    }
    case 'balanceOf': return encodeFunctionResult({ abi: NFT_ABI, functionName: 'balanceOf', result: state.balances1155.get(`${to}:${decoded.args[1]}`) ?? 0n });
    case 'isApprovedForAll': return encodeFunctionResult({ abi: NFT_ABI, functionName: 'isApprovedForAll', result: state.approvals.has(to) && (decoded.args[1] as string).toLowerCase() === OPENSEA_CONDUIT_ADDRESS });
    case 'supportsInterface': return encodeFunctionResult({ abi: NFT_ABI, functionName: 'supportsInterface', result: state.erc1155.has(to) });
    default: return '0x';
  }
}

export type ApiRoute = (body: unknown, url: URL) => unknown;

export interface MockApi {
  routes: Map<string, ApiRoute>;
  requests: Array<{ method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

export function mockApi(): MockApi {
  const routes = new Map<string, ApiRoute>();
  const requests: MockApi['requests'] = [];
  return {
    routes,
    requests,
    async fetch(input, init) {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: (init?.headers ?? {}) as Record<string, string> });
      const route = routes.get(`${method} ${url.pathname}`);
      if (!route) return new Response(JSON.stringify({ success: false, message: 'Not found' }), { status: 404 });
      try {
        const data = route(body, url);
        if (data instanceof Response) return data;
        return new Response(JSON.stringify({ success: true, data }), { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: (err as Error).message }), { status: 422 });
      }
    },
  };
}

export function listingRequirements(chainId: number, items: Array<{ contract: string; tokenId: string }>, overrides: Record<string, unknown> = {}, royaltyWei = '0') {
  return {
    seaport: SEAPORT_ADDRESS,
    conduitKey: OPENSEA_CONDUIT_KEY,
    conduit: OPENSEA_CONDUIT_ADDRESS,
    feeRecipient: chainId === 33139 ? '0x70a5af9ff16b9c436dbe6c1796930f4e1795abc6' : MAINNET_FEE_RECIPIENT,
    feeBps: 100,
    items: items.map(item => ({ contract: item.contract, tokenId: item.tokenId, blocked: false, reason: null, royaltyRecipient: ROYALTY_RECIPIENT, royaltyWei, opensea: null })),
    ...overrides,
  };
}

export interface Harness {
  handler: ToolHandler;
  ctx: Ctx;
  chain: ChainState;
  api: MockApi;
  outputs: string[];
  settings: SettingsStore;
  call: (name: string, args?: unknown) => Promise<{ text: string; isError: boolean }>;
  setNow: (ms: number) => void;
}

export function harness(options: { env?: Record<string, string>; logsFor?: LogsFor; now?: number } = {}): Harness {
  const env: NodeJS.ProcessEnv = {
    OSWIKI_WALLET_KEY: TEST_KEY,
    OSWIKI_SIGN_STATE_DIR: mkdtempSync(join(tmpdir(), 'oswiki-sign-')),
    OSWIKI_MAX_BUY_ETH: '1000',
    OSWIKI_MAX_BUY_APE: '100000',
    ...options.env,
  };
  const wallet = loadWallet(env);
  const settings = SettingsStore.fromEnv(env, wallet.stateKey);
  const config = settings.load();
  const chain = newChainState();
  const api = mockApi();
  let now = options.now ?? Date.parse('2026-10-10T12:00:00Z');
  const logsFor: LogsFor = options.logsFor ?? (() => []);
  const ctx: Ctx = {
    config,
    account: wallet.account,
    api: new ApiClient({ apiKey: config.apiKey, fetch: api.fetch, base: 'https://api.test' }),
    chains: createChains(config, wallet.account, { transportFor: chainId => makeTransport(chainId, chain, tx => logsFor(tx)), pollingInterval: 5 }),
    state: new TradeState(config.stateDir, config.maxTradesPerDay, () => now),
    now: () => now,
  };
  const handler = createToolHandler(ctx, wallet.scrub, { confirmer: { available: () => true, ask: async () => 'confirmed' }, settings });
  const outputs: string[] = [];
  return {
    handler,
    ctx,
    chain,
    api,
    outputs,
    settings,
    setNow: (ms) => {
      now = ms;
    },
    call: async (name, args = {}) => {
      const result = await handler(name, args);
      const text = result.content.map(entry => entry.text).join('\n');
      outputs.push(text);
      return { text, isError: result.isError === true };
    },
  };
}

export function confirmIdOf(text: string): string {
  const match = /execute with confirmId ([0-9a-f-]{36})/.exec(text);
  if (!match) throw new Error(`no confirmId in: ${text}`);
  return match[1]!;
}

/** Card text with its line wrapping undone, for substring checks. */
export function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}
