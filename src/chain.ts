import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  formatUnits,
  http,
  HttpRequestError,
  keccak256,
  maxUint256,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { apeChain, mainnet } from 'viem/chains';

import {
  FULFILL_ADVANCED_ORDER_ABI,
  FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI,
  FULFILL_BASIC_ORDER_ABI,
  MATCH_ADVANCED_ORDERS_ABI,
  NFT_ABI,
  OSWIKI_DOMAIN_TAG,
  SEAPORT_CANCEL_ABI,
  WRAPPED_NATIVE_ABI,
} from './abi.js';
import type { Config } from './config.js';
import { APECHAIN_ID, MAINNET_ID, OPENSEA_CONDUIT_ADDRESS, SEAPORT_ADDRESS, WRAPPED_NATIVE, type SupportedChainId } from './constants.js';
import { native } from './format.js';
import { revertMessage } from './seaport/fulfill.js';
import type { PendingTx } from './state.js';
import { NFT_TRANSFER_ABI, WRAPPED_TRANSFER_ABI } from './transfer-abi.js';

const CHAINS: Record<SupportedChainId, Chain> = { [MAINNET_ID]: mainnet, [APECHAIN_ID]: apeChain };

export interface PendingTracker {
  pendingTxs(chainId?: SupportedChainId): PendingTx[];
  addPending(entry: PendingTx): void;
  removePending(hash: string): void;
}

export interface Chains {
  client(chainId: SupportedChainId): PublicClient;
  wallet(chainId: SupportedChainId): WalletClient;
  maxFeePerGas(chainId: SupportedChainId): bigint;
  tracker?: PendingTracker;
  receiptTimeoutMs?: number;
}

export function createChains(config: Config, account: PrivateKeyAccount, options: { transportFor?: (chainId: SupportedChainId) => Transport; pollingInterval?: number; tracker?: PendingTracker; receiptTimeoutMs?: number } = {}): Chains {
  const publics = new Map<number, PublicClient>();
  const wallets = new Map<number, WalletClient>();
  const transport = (chainId: SupportedChainId) => options.transportFor?.(chainId) ?? http(config.rpc[chainId], { timeout: 30_000, retryCount: 1 });
  return {
    client(chainId) {
      let client = publics.get(chainId);
      if (!client) {
        client = createPublicClient({ chain: CHAINS[chainId], transport: transport(chainId), pollingInterval: options.pollingInterval ?? 4000, ccipRead: false }) as PublicClient;
        publics.set(chainId, client);
      }
      return client;
    },
    wallet(chainId) {
      let wallet = wallets.get(chainId);
      if (!wallet) {
        wallet = createWalletClient({ account, chain: CHAINS[chainId], transport: transport(chainId), pollingInterval: options.pollingInterval ?? 4000, ccipRead: false });
        wallets.set(chainId, wallet);
      }
      return wallet;
    },
    maxFeePerGas: chainId => config.maxFeePerGasWei[chainId],
    tracker: options.tracker,
    receiptTimeoutMs: options.receiptTimeoutMs,
  };
}

const EXPLORER_TX: Record<SupportedChainId, string> = { [MAINNET_ID]: 'etherscan.io/tx/', [APECHAIN_ID]: 'apescan.io/tx/' };
const CHAIN_LABEL: Record<SupportedChainId, string> = { [MAINNET_ID]: 'Ethereum', [APECHAIN_ID]: 'ApeChain' };

/** The transaction was (or may have been) broadcast: it can still land, so callers must never report it as not sent. */
export class UnconfirmedTxError extends Error {
  constructor(readonly chainId: SupportedChainId, readonly hash: Hex, readonly broadcastUncertain = false) {
    const head = broadcastUncertain
      ? `MAY HAVE BEEN SENT, not confirmed: ${hash} (the RPC did not answer the broadcast)`
      : `SENT, not yet confirmed: ${hash}`;
    super(`${head} - do not retry; check the explorer: ${EXPLORER_TX[chainId]}${hash}. It stays tracked as pending: nothing new is sent on ${CHAIN_LABEL[chainId]} until it confirms or is replaced.`);
    this.name = 'UnconfirmedTxError';
  }
}

function isTransportFailure(err: unknown): boolean {
  return err instanceof BaseError && err.walk(e => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof WebSocketRequestError || e instanceof SocketClosedError) !== null;
}

export class TxRefusedError extends Error {
  constructor(reason: string) {
    super(`Transaction refused: ${reason}. Nothing was sent.`);
    this.name = 'TxRefusedError';
  }
}

export interface TxRequest {
  chainId: SupportedChainId;
  to: Address;
  data: Hex;
  value: bigint;
}

export type TxKind = 'approve' | 'setApprovalForAll' | 'wrap' | 'cancel' | 'buy' | 'accept' | 'transfer721' | 'transfer1155' | 'transfer1155Batch' | 'send' | 'erc20Transfer' | 'unwrap';

/** The one recipient a send may name; transfer calldata from or to anyone else is refused. */
export interface SendTarget {
  from: Address;
  to: Address;
}

export interface TxShape {
  kind: TxKind;
  orders: number;
}

const GAS_BASE: Record<TxKind, bigint> = {
  approve: 100_000n,
  setApprovalForAll: 120_000n,
  wrap: 80_000n,
  cancel: 60_000n,
  buy: 300_000n,
  accept: 400_000n,
  transfer721: 90_000n,
  transfer1155: 80_000n,
  transfer1155Batch: 60_000n,
  send: 21_000n,
  erc20Transfer: 70_000n,
  unwrap: 50_000n,
};
const GAS_PER_ORDER: Record<TxKind, bigint> = {
  approve: 0n,
  setApprovalForAll: 0n,
  wrap: 0n,
  cancel: 40_000n,
  buy: 150_000n,
  accept: 0n,
  transfer721: 0n,
  transfer1155: 0n,
  transfer1155Batch: 40_000n,
  send: 0n,
  erc20Transfer: 0n,
  unwrap: 0n,
};
// ApeChain gas estimates include the parent-chain data cost, so a plain value transfer costs more than 21000 there.
const GAS_CHAIN_OVERRIDE: Record<SupportedChainId, Partial<Record<TxKind, bigint>>> = { [MAINNET_ID]: {}, [APECHAIN_ID]: { send: 150_000n } };
const GAS_CHAIN_FACTOR: Record<SupportedChainId, bigint> = { [MAINNET_ID]: 1n, [APECHAIN_ID]: 2n };
const MAX_PRIORITY_FEE: Record<SupportedChainId, bigint | null> = { [MAINNET_ID]: 10_000_000_000n, [APECHAIN_ID]: null };
export const MAX_GWEI_VARIABLE: Record<SupportedChainId, string> = { [MAINNET_ID]: 'OSWIKI_MAX_GWEI', [APECHAIN_ID]: 'OSWIKI_MAX_GWEI_APECHAIN' };
export const PENDING_GRACE_MS = 30 * 60_000;
export const RECEIPT_TIMEOUT_MS = 180_000;

export function gasLimitCap(chainId: SupportedChainId, shape: TxShape): bigint {
  const override = GAS_CHAIN_OVERRIDE[chainId][shape.kind];
  if (override !== undefined) return override;
  return (GAS_BASE[shape.kind] + GAS_PER_ORDER[shape.kind] * BigInt(Math.max(1, shape.orders))) * GAS_CHAIN_FACTOR[chainId];
}

const SEAPORT_KIND: Record<string, TxKind> = {
  fulfillAdvancedOrder: 'buy',
  fulfillAvailableAdvancedOrders: 'buy',
  fulfillBasicOrder_efficient_6GL6yc: 'accept',
  matchAdvancedOrders: 'accept',
  cancel: 'cancel',
};
const SEAPORT_PAYABLE = new Set(['fulfillAdvancedOrder', 'fulfillAvailableAdvancedOrders']);
const WRAPPED_FUNCTIONS_ABI = [...WRAPPED_NATIVE_ABI, ...WRAPPED_TRANSFER_ABI];
const NFT_FUNCTIONS_ABI = [...NFT_ABI, ...NFT_TRANSFER_ABI];
const SEAPORT_FUNCTIONS_ABI = [...FULFILL_ADVANCED_ORDER_ABI, ...FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, ...FULFILL_BASIC_ORDER_ABI, ...MATCH_ADVANCED_ORDERS_ABI, ...SEAPORT_CANCEL_ABI];

/**
 * The only transactions this program sends: Seaport fills/cancels (domain-tagged), wrap and an
 * exact (never max) WETH/WAPE approval to Seaport, and setApprovalForAll(OpenSea conduit) on a
 * collection the current plan trades. A send adds value, NFT and WETH/WAPE transfers to its one approved
 * recipient; unwrap returns WETH/WAPE to this wallet.
 */
export function assertAllowedTx(tx: TxRequest, nftContracts: ReadonlySet<string>, send?: SendTarget): TxShape {
  const to = tx.to.toLowerCase();
  if (tx.value < 0n) throw new TxRefusedError('negative value');
  const recipient = send?.to.toLowerCase();
  const same = (value: unknown, expected: string | undefined) => typeof value === 'string' && expected !== undefined && value.toLowerCase() === expected;

  if (tx.data === '0x') {
    if (recipient === undefined || to !== recipient) throw new TxRefusedError('plain value transfer to an address that is not the approved recipient');
    if (tx.value <= 0n) throw new TxRefusedError('send without value');
    return { kind: 'send', orders: 1 };
  }

  if (to === SEAPORT_ADDRESS) {
    if (!tx.data.toLowerCase().endsWith(OSWIKI_DOMAIN_TAG.slice(2))) throw new TxRefusedError('Seaport calldata without the OSWiki tag');
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: SEAPORT_FUNCTIONS_ABI, data: tx.data.slice(0, -8) as Hex });
    } catch {
      throw new TxRefusedError('unknown Seaport function');
    }
    const name = decoded.functionName;
    const kind = SEAPORT_KIND[name];
    if (!kind) throw new TxRefusedError('unknown Seaport function');
    if (!SEAPORT_PAYABLE.has(name) && tx.value !== 0n) throw new TxRefusedError(`${name} must not carry value`);
    const first = (decoded.args as readonly unknown[] | undefined)?.[0];
    const orders = (name === 'fulfillAvailableAdvancedOrders' || name === 'cancel') && Array.isArray(first) ? first.length : 1;
    return { kind, orders };
  }

  if (to === WRAPPED_NATIVE[tx.chainId]) {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: WRAPPED_FUNCTIONS_ABI, data: tx.data });
    } catch {
      throw new TxRefusedError('unknown wrapped-token function');
    }
    if (decoded.functionName === 'withdraw') {
      if (tx.value !== 0n) throw new TxRefusedError('withdraw must not carry value');
      return { kind: 'unwrap', orders: 1 };
    }
    if (decoded.functionName === 'transfer') {
      if (!same(decoded.args[0], recipient)) throw new TxRefusedError('token transfer to an address that is not the approved recipient');
      if (tx.value !== 0n) throw new TxRefusedError('transfer must not carry value');
      return { kind: 'erc20Transfer', orders: 1 };
    }
    if (decoded.functionName === 'deposit') {
      if (tx.value <= 0n) throw new TxRefusedError('wrap without value');
      return { kind: 'wrap', orders: 1 };
    }
    if (decoded.functionName === 'approve') {
      const [spender, amount] = decoded.args as readonly [Address, bigint];
      if (spender.toLowerCase() !== SEAPORT_ADDRESS) throw new TxRefusedError('approval to an unknown spender');
      if (amount === maxUint256) throw new TxRefusedError('unlimited approval');
      if (tx.value !== 0n) throw new TxRefusedError('approve must not carry value');
      return { kind: 'approve', orders: 1 };
    }
    throw new TxRefusedError(`${decoded.functionName} is not allowed`);
  }

  if (nftContracts.has(to)) {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: NFT_FUNCTIONS_ABI, data: tx.data });
    } catch {
      throw new TxRefusedError('unknown collection function');
    }
    if (decoded.functionName === 'safeTransferFrom' || decoded.functionName === 'safeBatchTransferFrom') {
      const args = decoded.args as readonly unknown[];
      if (!same(args[0], send?.from.toLowerCase())) throw new TxRefusedError('NFT transfer from another wallet');
      if (!same(args[1], recipient)) throw new TxRefusedError('NFT transfer to an address that is not the approved recipient');
      if (tx.value !== 0n) throw new TxRefusedError('NFT transfer must not carry value');
      if (decoded.functionName === 'safeBatchTransferFrom') return { kind: 'transfer1155Batch', orders: (args[2] as readonly bigint[]).length };
      return { kind: args.length === 3 ? 'transfer721' : 'transfer1155', orders: 1 };
    }
    if (decoded.functionName !== 'setApprovalForAll') throw new TxRefusedError(`${decoded.functionName} is not allowed`);
    const [operator, approved] = decoded.args as readonly [Address, boolean];
    if (operator.toLowerCase() !== OPENSEA_CONDUIT_ADDRESS) throw new TxRefusedError('approval to an unknown operator');
    if (approved !== true) throw new TxRefusedError('only approvals are sent');
    if (tx.value !== 0n) throw new TxRefusedError('approval must not carry value');
    return { kind: 'setApprovalForAll', orders: 1 };
  }

  throw new TxRefusedError(`unknown target ${to}`);
}

export interface FeeQuote {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

function gwei(wei: bigint): string {
  return `${formatUnits(wei, 9)} gwei`;
}

/** Current EIP-1559 fees, refused above the per-chain gwei cap; the tip is clamped, never raised. */
export async function cappedFees(chains: Chains, chainId: SupportedChainId): Promise<FeeQuote> {
  const cap = chains.maxFeePerGas(chainId);
  const fees = await chains.client(chainId).estimateFeesPerGas();
  if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new TxRefusedError('the RPC returned no EIP-1559 fees');
  if (fees.maxFeePerGas > cap) {
    throw new TxRefusedError(`the network fee of ${gwei(fees.maxFeePerGas)} is above the limit of ${gwei(cap)} (${MAX_GWEI_VARIABLE[chainId]}); try again when gas is lower`);
  }
  const tipCap = MAX_PRIORITY_FEE[chainId] ?? cap;
  const tip = fees.maxPriorityFeePerGas > tipCap ? tipCap : fees.maxPriorityFeePerGas;
  return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: tip > fees.maxFeePerGas ? fees.maxFeePerGas : tip };
}

export interface NetworkFee {
  nowWei: bigint | null;
  maxWei: bigint;
  text: string;
}

/** Preview line for the transactions a plan may send: the current estimate and the ceiling the gas and fee caps allow. */
export async function networkFee(chains: Chains, chainId: SupportedChainId, txs: Array<{ shape: TxShape; estimate?: bigint }>): Promise<NetworkFee> {
  if (txs.length === 0) return { nowWei: 0n, maxWei: 0n, text: 'Network fee: none, nothing is sent on-chain.' };
  const cap = chains.maxFeePerGas(chainId);
  const maxWei = txs.reduce((sum, tx) => sum + gasLimitCap(chainId, tx.shape), 0n) * cap;
  const ceiling = `at most ${native(maxWei, chainId)} (gas limit caps x ${gwei(cap)}, ${MAX_GWEI_VARIABLE[chainId]})`;
  try {
    const fees = await chains.client(chainId).estimateFeesPerGas();
    const perGas = fees.maxFeePerGas ?? 0n;
    const nowWei = txs.reduce((sum, tx) => sum + (tx.estimate ?? gasLimitCap(chainId, tx.shape)), 0n) * perGas;
    const over = perGas > cap ? ` Gas is above ${MAX_GWEI_VARIABLE[chainId]} right now, so execute will refuse until it drops.` : '';
    return { nowWei, maxWei, text: `Network fee: about ${native(nowWei, chainId)} now, ${ceiling}.${over}` };
  } catch {
    return { nowWei: null, maxWei, text: `Network fee: estimate unavailable, ${ceiling}.` };
  }
}

export class PendingTxError extends Error {
  constructor(entry: PendingTx) {
    super(`A previous ${entry.label} transaction ${entry.hash} from this wallet is still pending on ${entry.chainId === MAINNET_ID ? 'Ethereum' : 'ApeChain'}. Wait until it confirms (or replace it in your wallet app), then run the preview again. Nothing was signed or sent.`);
    this.name = 'PendingTxError';
  }
}

/** A tracked tx is cleared once mined or its nonce is used; while it may still land, nothing new is sent on that chain. */
export async function assertNoPendingTx(chains: Chains, account: PrivateKeyAccount, chainId: SupportedChainId, now: () => number = Date.now): Promise<void> {
  const tracker = chains.tracker;
  if (!tracker) return;
  const client = chains.client(chainId);
  for (const entry of tracker.pendingTxs(chainId)) {
    const receipt = await client.getTransactionReceipt({ hash: entry.hash }).catch(() => null);
    if (receipt) {
      tracker.removePending(entry.hash);
      continue;
    }
    const known = await client.getTransaction({ hash: entry.hash }).catch(() => null);
    if (known) throw new PendingTxError(entry);
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'latest' }).catch(() => null);
    if ((nonce !== null && nonce > entry.nonce) || now() - entry.sentAt > PENDING_GRACE_MS) {
      tracker.removePending(entry.hash);
      continue;
    }
    throw new PendingTxError(entry);
  }
}

export interface SentTx {
  hash: Hex;
  logs: Log[];
}

/** Allowlist, simulation from the wallet, gas and fee caps, then send and wait; a revert anywhere aborts. */
export async function sendGuardedTx(chains: Chains, account: PrivateKeyAccount, tx: TxRequest, nftContracts: ReadonlySet<string>, send?: SendTarget): Promise<SentTx> {
  const shape = assertAllowedTx(tx, nftContracts, send);
  const client = chains.client(tx.chainId);
  const request = { account: account.address, to: tx.to, data: tx.data, value: tx.value };
  try {
    await client.call(request);
  } catch (err) {
    throw new Error(`Simulation failed: ${revertMessage(err)}. Nothing was sent.`);
  }
  let estimate: bigint;
  try {
    estimate = await client.estimateGas(request);
  } catch (err) {
    throw new Error(`Gas estimate failed: ${revertMessage(err)}. Nothing was sent.`);
  }
  const gasCap = gasLimitCap(tx.chainId, shape);
  if (estimate > gasCap) throw new TxRefusedError(`the gas estimate of ${estimate} is above the ${shape.kind} limit of ${gasCap}`);
  const padded = (estimate * 6n) / 5n;
  const gas = padded > gasCap ? gasCap : padded;
  const fees = await cappedFees(chains, tx.chainId);
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });

  const serializedTransaction = await account.signTransaction({ type: 'eip1559', chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value, gas, nonce, ...fees });
  const hash = keccak256(serializedTransaction);
  const track = () => chains.tracker?.addPending({ chainId: tx.chainId, hash, nonce, label: shape.kind, sentAt: Date.now() });
  try {
    await client.sendRawTransaction({ serializedTransaction });
  } catch (err) {
    if (!isTransportFailure(err)) throw err;
    track();
    throw new UnconfirmedTxError(tx.chainId, hash, true);
  }
  track();
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: chains.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS });
  } catch {
    throw new UnconfirmedTxError(tx.chainId, hash);
  }
  chains.tracker?.removePending(hash);
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted on-chain.`);
  return { hash, logs: receipt.logs };
}

