import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { namehash, normalize } from 'viem/ens';

import type { ApiClient } from '../api.js';
import { APECHAIN_ID, type SupportedChainId } from '../constants.js';
import { ENS_ADDR_COIN_ABI, ENS_REGISTRY_ABI, ENS_REGISTRY_ADDRESS, ENS_RESOLVER_ABI } from '../transfer-abi.js';
import { GuardError } from './common.js';

const ENS_NAME_RE = /^[^\s/:@]{1,200}\.[^\s/:@.]{2,30}$/u;

export const APECHAIN_COIN_TYPE = 0x80000000n | BigInt(APECHAIN_ID);

export function looksLikeEnsName(value: string): boolean {
  return ENS_NAME_RE.test(value) && !value.startsWith('0x');
}

async function resolverOf(client: PublicClient, node: `0x${string}`): Promise<Address | null> {
  const resolver = await client.readContract({ address: ENS_REGISTRY_ADDRESS, abi: ENS_REGISTRY_ABI, functionName: 'resolver', args: [node] });
  return resolver.toLowerCase() === zeroAddress ? null : resolver;
}

/** Normalized name or a GuardError; only names with an on-chain resolver on Ethereum resolve here (no CCIP-read). */
export function normalizeEnsName(name: string): string {
  try {
    return normalize(name.trim());
  } catch {
    throw new GuardError(`"${name.slice(0, 60)}" is not a valid ENS name. Ask the user for the full 0x address instead. Nothing was sent.`);
  }
}

/** Non-ASCII or punycode labels can imitate another name letter for letter. */
export function isConfusableName(name: string): boolean {
  return /[^\x20-\x7e]/u.test(name) || /(^|\.)xn--/i.test(name);
}

export async function resolveEnsName(client: PublicClient, name: string): Promise<Address | null> {
  const node = namehash(normalizeEnsName(name));
  const resolver = await resolverOf(client, node);
  if (!resolver) return null;
  const address = await client.readContract({ address: resolver, abi: ENS_RESOLVER_ABI, functionName: 'addr', args: [node] });
  return address.toLowerCase() === zeroAddress ? null : address.toLowerCase() as Address;
}

function coinAddress(raw: Hex): string | null {
  return raw.length === 42 && raw.toLowerCase() !== zeroAddress ? raw.toLowerCase() : null;
}

/** ENSIP-11 address of a name for an EVM chain; null when unset or the resolver predates multi-coin records. */
async function resolveCoinAddress(client: PublicClient, name: string, coinType: bigint): Promise<string | null> {
  const node = namehash(normalizeEnsName(name));
  const resolver = await resolverOf(client, node);
  if (!resolver) return null;
  try {
    const raw = await client.readContract({ address: resolver, abi: ENS_ADDR_COIN_ABI, functionName: 'addr', args: [node, coinType] });
    return coinAddress(raw);
  } catch (err) {
    if (err instanceof BaseError && err.walk(e => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) return null;
    throw err;
  }
}

export interface VerifiedEns {
  name: string;
  address: Address;
}

const ASK_ADDRESS = 'Ask the user for the full 0x address. Nothing was sent.';

/**
 * Forward-resolves through the user's Ethereum RPC and the OSWiki API independently and refuses unless both agree;
 * on ApeChain the name must also carry an ENSIP-11 ApeChain address equal to its Ethereum address.
 */
export async function resolveEnsVerified(client: PublicClient, api: ApiClient, input: string, chainId: SupportedChainId): Promise<VerifiedEns> {
  const name = normalizeEnsName(input);
  const ape = chainId === APECHAIN_ID;
  const [rpc, remote] = await Promise.allSettled([
    Promise.all([resolveEnsName(client, name), ape ? resolveCoinAddress(client, name, APECHAIN_COIN_TYPE) : Promise.resolve(null)]),
    api.ensResolve(name, chainId),
  ]);
  if (rpc.status === 'rejected') throw new GuardError(`Could not look up the ENS name ${name} through the Ethereum RPC right now. Try again, or ${ASK_ADDRESS}`);
  if (remote.status === 'rejected') throw new GuardError(`ENS names need a second, independent lookup through the OSWiki API, and it is unavailable right now, so ${name} is refused. ${ASK_ADDRESS}`);
  const [address, apeAddress] = rpc.value;
  const other = remote.value;
  if ((address ?? null) !== other.address) {
    throw new GuardError(`Refused: the Ethereum RPC and the OSWiki API disagree about ${name} (${address ?? 'no address'} vs ${other.address ?? 'no address'}). Do not send to this name. ${ASK_ADDRESS}`);
  }
  if (!address) throw new GuardError(`The ENS name ${name} does not resolve to an address (or uses an off-chain resolver this signer does not follow). ${ASK_ADDRESS}`);
  if (ape) {
    if (apeAddress !== other.apechainAddress) {
      throw new GuardError(`Refused: the Ethereum RPC and the OSWiki API disagree about the ApeChain address of ${name} (${apeAddress ?? 'none'} vs ${other.apechainAddress ?? 'none'}). ${ASK_ADDRESS}`);
    }
    if (!apeAddress) throw new GuardError(`Refused: ${name} has no ApeChain address set (ENSIP-11 coin type ${APECHAIN_COIN_TYPE}); its Ethereum address may not belong to the same owner on ApeChain. ${ASK_ADDRESS}`);
    if (apeAddress !== address) throw new GuardError(`Refused: the ApeChain address set for ${name} (${apeAddress}) differs from its Ethereum address (${address}). ${ASK_ADDRESS}`);
  }
  return { name, address };
}

/** Primary ENS name of an address, only when it resolves forward to the same address; null on any failure. */
export async function reverseEnsName(client: PublicClient, address: Address): Promise<string | null> {
  try {
    const node = namehash(`${address.slice(2).toLowerCase()}.addr.reverse`);
    const resolver = await resolverOf(client, node);
    if (!resolver) return null;
    const name = await client.readContract({ address: resolver, abi: ENS_RESOLVER_ABI, functionName: 'name', args: [node] });
    if (!name || name.length > 100 || normalize(name) !== name) return null;
    const forward = await resolveEnsName(client, name);
    return forward === address.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}
