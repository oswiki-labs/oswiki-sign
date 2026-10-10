import type { CollectionInfo, VerifiedCollection } from '../api.js';
import type { SupportedChainId } from '../constants.js';
import { native } from '../format.js';
import { floorToWei, type Ctx } from './common.js';

export const PRICE_OVER_FLOOR_FACTOR = 3n;

export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Levenshtein distance, giving up (returning max + 1) once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** Short names get a tighter threshold so "Ape" does not match every three-letter name. */
export function findLookalike(name: string, address: string, verified: VerifiedCollection[]): VerifiedCollection | null {
  const wanted = normalizeName(name);
  if (wanted.length < 3) return null;
  const own = address.toLowerCase();
  for (const candidate of verified) {
    if (candidate.address === own) continue;
    const other = normalizeName(candidate.name);
    if (other.length < 3) continue;
    const max = Math.min(wanted.length, other.length) >= 5 ? 2 : 1;
    if (editDistance(wanted, other, max) <= max) return candidate;
  }
  return null;
}

export interface CollectionCheck {
  name: string;
  lines: string[];
  floorWei: bigint | null;
}

/** Buy-side context for one collection: name, verified badge, floor, and copycat warnings. Never blocks. */
export async function checkBuyCollection(ctx: Ctx, chainId: SupportedChainId, contract: string, verifiedList: VerifiedCollection[] | null): Promise<CollectionCheck> {
  const info: CollectionInfo | null = await ctx.api.collection(chainId, contract).catch(() => null);
  if (!info) {
    return { name: contract, floorWei: null, lines: [`- Collection ${contract}: profile unavailable.`, `  WARNING: the collection profile could not be loaded, so its name, verified status and floor are unchecked. Confirm the contract address ${contract} with the user.`] };
  }
  const name = info.name || contract;
  const floorWei = floorToWei(info.floorPrice);
  const badge = info.verified === true ? 'verified on OSWiki' : info.verified === false ? 'NOT verified' : 'verified status unknown';
  const lines = [`- Collection ${name} (${contract}): ${badge}, floor ${floorWei === null ? 'none (no active listings)' : native(floorWei, chainId)}.`];
  if (info.verified !== true) lines.push(`  WARNING: ${name} is not a verified collection. Confirm the contract address ${contract} with the user before buying.`);
  if (info.verified !== true && info.name) {
    const lookalike = verifiedList ? findLookalike(info.name, contract, verifiedList) : null;
    if (lookalike) lines.push(`  WARNING: "${name}" looks like the verified collection "${lookalike.name}" (${lookalike.address}), but this is a different contract (${contract}). It may be a copycat.`);
    if (!verifiedList) lines.push('  NOTE: the verified collection list could not be loaded, so copycat names were not checked.');
  }
  return { name, lines, floorWei };
}
