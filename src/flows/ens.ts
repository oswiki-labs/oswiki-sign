import { zeroAddress, type Address, type PublicClient } from 'viem';
import { namehash, normalize } from 'viem/ens';

import { ENS_REGISTRY_ABI, ENS_REGISTRY_ADDRESS, ENS_RESOLVER_ABI } from '../transfer-abi.js';
import { GuardError } from './common.js';

const ENS_NAME_RE = /^[^\s/:@]{1,200}\.[^\s/:@.]{2,30}$/u;

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

export async function resolveEnsName(client: PublicClient, name: string): Promise<Address | null> {
  const node = namehash(normalizeEnsName(name));
  const resolver = await resolverOf(client, node);
  if (!resolver) return null;
  const address = await client.readContract({ address: resolver, abi: ENS_RESOLVER_ABI, functionName: 'addr', args: [node] });
  return address.toLowerCase() === zeroAddress ? null : address.toLowerCase() as Address;
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
