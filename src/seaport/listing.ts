import type { Address, PublicClient } from 'viem';

import { NFT_ABI, SEAPORT_GET_COUNTER_ABI } from '../abi.js';
import {
  APECHAIN_MIN_FEE_BPS,
  getOswikiFeeRecipient,
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  OSWIKI_FEE_BPS,
  SEAPORT_ADDRESS,
} from '../constants.js';

export const MAX_SEAPORT_FEE_BPS = Math.max(OSWIKI_FEE_BPS, APECHAIN_MIN_FEE_BPS);
/** The public API always charges the standard fee; anything else from the server is refused. */
export const REQUIRED_FEE_BPS = OSWIKI_FEE_BPS;
export const MAX_ROYALTY_BPS = 2500;
export const MAX_LISTINGS_PER_REQUEST = 100;

export interface OpenSeaListingTerms {
  chain: string;
  protocolAddress: string;
  conduitKey: string;
  zone: string;
  orderType: number;
  feeRecipient: string;
  feeBps: number;
  creatorFees: Array<{ recipient: string; bps: number }>;
}

export interface SeaportRequirementsItem {
  contract: string;
  tokenId: string;
  blocked: boolean;
  reason: string | null;
  royaltyRecipient: string | null;
  royaltyWei: string;
  opensea?: OpenSeaListingTerms | null;
}

export interface SeaportRequirements {
  seaport: string;
  conduitKey: string;
  conduit: string;
  feeRecipient: string;
  feeBps: number;
  items: SeaportRequirementsItem[];
}

export class ListingRequirementsError extends Error {
  constructor(reason: string) {
    super(`The listing terms from the server did not pass a safety check (${reason}). Nothing was signed.`);
    this.name = 'ListingRequirementsError';
  }
}

export class CounterUnavailableError extends Error {
  constructor() {
    super('Could not read the Seaport counter from the chain. Nothing was signed; try again.');
    this.name = 'CounterUnavailableError';
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

/** Approval target, Seaport and fee recipient must be our constants, never the server's say-so. */
export function assertSeaportRequirements(requirements: SeaportRequirements, chainId: number, itemCount: number): void {
  const fail = (reason: string): never => {
    throw new ListingRequirementsError(reason);
  };
  if (!requirements || typeof requirements !== 'object') fail('missing requirements');
  if (requirements.seaport?.toLowerCase() !== SEAPORT_ADDRESS) fail('unexpected Seaport address');
  if (requirements.conduitKey?.toLowerCase() !== OPENSEA_CONDUIT_KEY) fail('unexpected conduit key');
  if (requirements.conduit?.toLowerCase() !== OPENSEA_CONDUIT_ADDRESS) fail('unexpected conduit');
  if (requirements.feeRecipient?.toLowerCase() !== getOswikiFeeRecipient(chainId).toLowerCase()) fail('unexpected fee recipient');
  if (requirements.feeBps !== REQUIRED_FEE_BPS) fail('unexpected fee');
  if (!Array.isArray(requirements.items) || requirements.items.length !== itemCount) fail('item count mismatch');
}

export function requirementFor(requirements: SeaportRequirements, contract: string, tokenId: string): SeaportRequirementsItem {
  const item = requirements.items.find(entry => entry?.contract?.toLowerCase() === contract.toLowerCase() && String(entry.tokenId) === String(tokenId));
  if (!item) throw new ListingRequirementsError('missing item');
  if (typeof item.royaltyWei !== 'string' || !UINT_RE.test(item.royaltyWei)) throw new ListingRequirementsError('invalid royalty');
  if (item.royaltyRecipient && !ADDRESS_RE.test(item.royaltyRecipient)) throw new ListingRequirementsError('invalid royalty recipient');
  return item;
}

export function checkRoyaltyCap(item: SeaportRequirementsItem, totalWei: bigint): void {
  if (BigInt(item.royaltyWei) * 10000n > totalWei * BigInt(MAX_ROYALTY_BPS)) throw new ListingRequirementsError('royalty too high');
}

/** Counter is mandatory: a failed read aborts rather than guessing 0. */
export async function readSeaportCounter(client: PublicClient, offerer: Address): Promise<bigint> {
  try {
    const counter = await client.readContract({ address: SEAPORT_ADDRESS, abi: SEAPORT_GET_COUNTER_ABI, functionName: 'getCounter', args: [offerer] });
    if (typeof counter !== 'bigint' || counter < 0n) throw new Error('bad counter');
    return counter;
  } catch {
    throw new CounterUnavailableError();
  }
}

const ERC2981_INTERFACE_ID = '0x2a55205a' as const;
const ROYALTY_INFO_ABI = [{
  type: 'function',
  name: 'royaltyInfo',
  stateMutability: 'view',
  inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'salePrice', type: 'uint256' }],
  outputs: [{ name: 'receiver', type: 'address' }, { name: 'royaltyAmount', type: 'uint256' }],
}] as const;

export interface OnchainRoyalty {
  recipient: Address;
  amount: bigint;
}

/** ERC-2981 royaltyInfo for the sale, or null when the collection does not implement it. */
export async function readOnchainRoyalty(client: PublicClient, contract: Address, tokenId: string, salePriceWei: bigint): Promise<OnchainRoyalty | null> {
  try {
    const supported = await client.readContract({ address: contract, abi: NFT_ABI, functionName: 'supportsInterface', args: [ERC2981_INTERFACE_ID] });
    if (supported !== true) return null;
    const [recipient, amount] = await client.readContract({ address: contract, abi: ROYALTY_INFO_ABI, functionName: 'royaltyInfo', args: [BigInt(tokenId), salePriceWei] });
    return { recipient: recipient.toLowerCase() as Address, amount };
  } catch {
    return null;
  }
}

export const MAX_UNVERIFIED_ROYALTY_BPS = 1000;
export const UNVERIFIED_ROYALTY_LABEL = 'UNVERIFIED (from OSWiki API, collection has no on-chain royalty info)';

export interface VerifiedRoyalty {
  recipient: Address | null;
  wei: bigint;
  source: 'ERC-2981' | 'api' | 'none';
}

export interface PaidRoyalty {
  recipient: string | null;
  wei: bigint;
  totalWei: bigint;
  quantity: bigint;
}

/**
 * ERC-2981 when the collection answers it; otherwise the royalty is only the API's word: it must
 * match the hosted royalty when `hosted` is given (required unless `requireHosted` is false) and is
 * capped at 10%.
 */
export function verifyRoyalty(
  paid: PaidRoyalty,
  onchain: OnchainRoyalty | null,
  hosted: { bps: number; recipient: string } | null,
  fail: (reason: string) => never,
  requireHosted = true,
): VerifiedRoyalty {
  if (paid.wei === 0n || paid.recipient === null) return { recipient: null, wei: 0n, source: onchain ? 'ERC-2981' : hosted ? 'api' : 'none' };
  const recipient = paid.recipient.toLowerCase() as Address;
  if (onchain) {
    if (onchain.recipient !== recipient) fail(`royalty recipient ${recipient} is not the collection's on-chain royalty receiver ${onchain.recipient}`);
    if (paid.wei > onchain.amount + paid.quantity) fail('royalty is above the collection\'s on-chain royaltyInfo');
    return { recipient, wei: paid.wei, source: 'ERC-2981' };
  }
  if (paid.wei * 10000n > paid.totalWei * BigInt(MAX_UNVERIFIED_ROYALTY_BPS)) {
    fail(`the royalty of ${Number((paid.wei * 10000n) / paid.totalWei) / 100}% comes only from the OSWiki API (the collection has no on-chain ERC-2981 royalty info), and oswiki-sign does not pay more than ${MAX_UNVERIFIED_ROYALTY_BPS / 100}% royalty without on-chain proof`);
  }
  if (hosted) {
    if (hosted.recipient.toLowerCase() !== recipient) fail(`royalty recipient ${recipient} is not the collection's royalty recipient ${hosted.recipient.toLowerCase()}`);
    const cap = (paid.totalWei * BigInt(hosted.bps) + 9999n) / 10000n + paid.quantity;
    if (paid.wei > cap) fail('royalty is above the collection\'s royalty');
    return { recipient, wei: paid.wei, source: 'api' };
  }
  if (requireHosted) return fail('the royalty recipient could not be verified: the collection has no ERC-2981 royaltyInfo and no royalty in its settings');
  return { recipient, wei: paid.wei, source: 'api' };
}

export function verifyListingRoyalty(paid: PaidRoyalty, onchain: OnchainRoyalty | null, hosted: { bps: number; recipient: string } | null): VerifiedRoyalty {
  return verifyRoyalty(paid, onchain, hosted, (reason) => {
    throw new ListingRequirementsError(reason);
  });
}

export function royaltySourceLabel(source: VerifiedRoyalty['source']): string {
  return source === 'ERC-2981' ? 'checked against the collection\'s on-chain ERC-2981 royaltyInfo' : UNVERIFIED_ROYALTY_LABEL;
}

export async function readConduitApproval(client: PublicClient, contract: string, owner: Address): Promise<boolean> {
  const approved = await client.readContract({
    address: contract as Address,
    abi: NFT_ABI,
    functionName: 'isApprovedForAll',
    args: [owner, OPENSEA_CONDUIT_ADDRESS],
  });
  return approved === true;
}
