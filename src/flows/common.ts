import { encodeFunctionData, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from 'viem';

import { ERC1155_INTERFACE_ID, NFT_ABI } from '../abi.js';
import type { ApiClient, BatchResult } from '../api.js';
import type { Chains } from '../chain.js';
import type { Config } from '../config.js';
import { isSupportedChain, NATIVE_SYMBOL, OPENSEA_CONDUIT_ADDRESS, type SupportedChainId } from '../constants.js';
import { native } from '../format.js';
import { isConduitRestriction } from '../seaport/fulfill.js';
import { serializeOrderComponents, type OrderComponents } from '../seaport/order.js';
import type { TradeState } from '../state.js';

export interface Ctx {
  config: Config;
  account: PrivateKeyAccount;
  api: ApiClient;
  chains: Chains;
  state: TradeState;
  now: () => number;
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

/** Its message is built only from our own text and sanitized server text, and must reach the AI whole. */
export class RejectedOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectedOrderError';
  }
}

export function rejectedOrdersText(chainId: SupportedChainId, what: string, reason: string, orders: OrderComponents[]): string {
  const call = JSON.stringify({ chainId, orders: orders.map(serializeOrderComponents) });
  return [
    `The OSWiki API did not accept ${what}: ${reason || 'no reason given'}.`,
    `${orders.length === 1 ? 'The signature is' : 'These signatures are'} still valid off-chain: anyone who has ${orders.length === 1 ? 'it' : 'them'} could fill the order${orders.length === 1 ? '' : 's'} until ${orders.length === 1 ? 'it expires' : 'they expire'}.`,
    `To make ${orders.length === 1 ? 'it' : 'them'} unusable, offer the user an on-chain cancel (gas paid by this wallet): call preview_cancel with ${call}`,
  ].join('\n');
}

/** Signed orders the bulk endpoint did not confirm: matched by id, else by position for a success without an id. */
export function unacceptedIndexes(signed: Array<{ orderHash: string }>, result: BatchResult, key: 'askId' | 'bidId'): number[] {
  const accepted = new Set(result.results.filter(entry => entry.success).map(entry => entry[key]).filter((id): id is string => typeof id === 'string'));
  return signed.flatMap((entry, i) => {
    if (accepted.has(`oswiki-${entry.orderHash.toLowerCase()}`)) return [];
    const row = result.results[i];
    return row?.success === true && row[key] === undefined ? [] : [i];
  });
}

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const TOKEN_ID_RE = /^(0|[1-9][0-9]{0,77})$/;
export const ORDER_ID_RE = /^oswiki-0x[0-9a-fA-F]{64}$/;

export function chainOf(value: unknown): SupportedChainId {
  if (!isSupportedChain(value)) throw new GuardError('chainId must be 1 (Ethereum) or 33139 (ApeChain).');
  return value;
}

export function me(ctx: Ctx): Address {
  return ctx.account.address.toLowerCase() as Address;
}

export function assertCollectionAllowed(config: Config, contract: string): void {
  if (config.allowedCollections && !config.allowedCollections.has(contract.toLowerCase())) {
    throw new GuardError(`Collection ${contract.toLowerCase()} is not in OSWIKI_ALLOWED_COLLECTIONS. Nothing was signed or sent.`);
  }
}

/** Buys and offers stay off on a chain until its per-trade limit is configured. */
export function assertBuyingEnabled(config: Config, chainId: SupportedChainId): bigint {
  const cap = config.maxBuyWei[chainId];
  if (cap === null) {
    const variable = `OSWIKI_MAX_BUY_${NATIVE_SYMBOL[chainId]}`;
    throw new GuardError(`Buying and offers on ${chainId === 1 ? 'Ethereum' : 'ApeChain'} are off until ${variable} is set. Ask the user to add ${variable} (the most one buy or offer may spend, e.g. "0.5") to the env block of oswiki-sign in their MCP client config and restart the client. Listing and cancelling still work. Nothing was signed or sent.`);
  }
  return cap;
}

export function assertMaxBuy(config: Config, chainId: SupportedChainId, totalWei: bigint, what: string): void {
  const cap = assertBuyingEnabled(config, chainId);
  if (totalWei > cap) {
    throw new GuardError(`${what} of ${native(totalWei, chainId)} is above the per-trade limit of ${native(cap, chainId)} (OSWIKI_MAX_BUY_${NATIVE_SYMBOL[chainId]}). Nothing was signed or sent.`);
  }
}

/** Float floor from the API to wei, to 1e-9 precision; null when there is no usable floor. */
export function floorToWei(floor: number | null | undefined): bigint | null {
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor <= 0) return null;
  return BigInt(Math.round(floor * 1e9)) * 10n ** 9n;
}

export async function readIsErc1155(client: PublicClient, contract: Address): Promise<boolean> {
  try {
    return await client.readContract({ address: contract, abi: NFT_ABI, functionName: 'supportsInterface', args: [ERC1155_INTERFACE_ID] }) === true;
  } catch {
    return false;
  }
}

export async function assertHolds(client: PublicClient, owner: Address, item: { contract: Address; tokenId: string; isErc1155: boolean; quantity: bigint }): Promise<void> {
  if (item.isErc1155) {
    let balance: bigint;
    try {
      balance = await client.readContract({ address: item.contract, abi: NFT_ABI, functionName: 'balanceOf', args: [owner, BigInt(item.tokenId)] });
    } catch {
      throw new GuardError(`Could not read the balance of ${item.contract} #${item.tokenId}. Nothing was signed or sent.`);
    }
    if (balance < item.quantity) throw new GuardError(`This wallet holds ${balance} of ${item.contract} #${item.tokenId}, not ${item.quantity}. Nothing was signed or sent.`);
    return;
  }
  let holder: string;
  try {
    holder = await client.readContract({ address: item.contract, abi: NFT_ABI, functionName: 'ownerOf', args: [BigInt(item.tokenId)] });
  } catch {
    throw new GuardError(`Could not read the owner of ${item.contract} #${item.tokenId}. Nothing was signed or sent.`);
  }
  if (holder.toLowerCase() !== owner.toLowerCase()) throw new GuardError(`This wallet does not own ${item.contract} #${item.tokenId}. Nothing was signed or sent.`);
}

const CONDUIT_PROBE_RECEIVER = '0x1527ac91fcdf483960f811baac49125334a66a6a' as const;

/** The exact transfer a zone-0 Seaport fill makes, eth_call'd from the conduit; only a validator caller revert reads as blocked. */
export async function probeConduit(client: PublicClient, owner: Address, item: { contract: Address; tokenId: string; isErc1155: boolean; quantity: bigint }): Promise<'allowed' | 'blocked' | 'unknown'> {
  const data: Hex = item.isErc1155
    ? encodeFunctionData({ abi: NFT_ABI, functionName: 'safeTransferFrom', args: [owner, CONDUIT_PROBE_RECEIVER, BigInt(item.tokenId), item.quantity, '0x'] })
    : encodeFunctionData({ abi: NFT_ABI, functionName: 'transferFrom', args: [owner, CONDUIT_PROBE_RECEIVER, BigInt(item.tokenId)] });
  try {
    await client.call({ account: OPENSEA_CONDUIT_ADDRESS, to: item.contract, data });
    return 'allowed';
  } catch (err) {
    return isConduitRestriction(err) ? 'blocked' : 'unknown';
  }
}

export function setApprovalData(): Hex {
  return encodeFunctionData({ abi: NFT_ABI, functionName: 'setApprovalForAll', args: [OPENSEA_CONDUIT_ADDRESS, true] });
}

export type Chain = SupportedChainId;
export type { Chains };
