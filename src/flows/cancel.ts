import type { Address } from 'viem';

import { networkFee, sendGuardedTx } from '../chain.js';
import { SEAPORT_ADDRESS, type SupportedChainId } from '../constants.js';
import { cancelledOrderHashes } from '../seaport/fulfill.js';
import { chunkCancels, encodeSeaportCancel, prepareListingCancels, prepareSeaportCancel, type SeaportCancelTarget } from '../seaport/cancel.js';
import { pickOrderComponents } from '../seaport/order.js';
import { hashOrderComponents } from '../seaport/sign.js';
import { chainOf, GuardError, me, ORDER_ID_RE, type Ctx } from './common.js';

export const MAX_CANCELS = 100;

export interface CancelPlan {
  kind: 'cancel';
  chainId: SupportedChainId;
  wallet: Address;
  targets: SeaportCancelTarget[];
}

/** Components the AI passes back after a rejected submit: only this wallet's own orders, keyed by their own struct hash. */
function componentTarget(raw: Record<string, unknown>, offerer: string, index: number): SeaportCancelTarget {
  let orderHash: string;
  try {
    orderHash = hashOrderComponents(pickOrderComponents(raw));
  } catch {
    throw new GuardError(`orders[${index}] is not a readable Seaport order. Nothing was sent.`);
  }
  try {
    return prepareSeaportCancel(orderHash, raw, offerer);
  } catch {
    throw new GuardError(`orders[${index}] is not an order of this wallet. Nothing was sent.`);
  }
}

export async function previewCancel(ctx: Ctx, input: { chainId: number; askIds?: string[]; bidIds?: string[]; orders?: Array<Record<string, unknown>> }): Promise<{ text: string; plan: CancelPlan }> {
  const chainId = chainOf(input.chainId);
  const askIds = [...new Set(input.askIds ?? [])];
  const bidIds = [...new Set(input.bidIds ?? [])];
  const rawOrders = input.orders ?? [];
  if (askIds.length + bidIds.length + rawOrders.length === 0) throw new GuardError('Nothing to cancel.');
  if (askIds.length + bidIds.length + rawOrders.length > MAX_CANCELS) throw new GuardError(`Cancel at most ${MAX_CANCELS} orders at once.`);
  const bad = [...askIds, ...bidIds].filter(id => !ORDER_ID_RE.test(id));
  if (bad.length > 0) throw new GuardError(`Ids must look like "oswiki-0x...": ${bad.join(', ').slice(0, 200)}.`);
  const offerer = me(ctx);
  const direct = rawOrders.map((raw, i) => componentTarget(raw, offerer, i));

  const [asks, bids] = await Promise.all([
    Promise.all(askIds.map(async (id) => {
      const stored = await ctx.api.askComponents(chainId, id);
      return prepareListingCancels(id, stored.components, stored.twin, offerer);
    })),
    Promise.all(bidIds.map(async (id) => {
      const stored = await ctx.api.bidComponents(chainId, id);
      return [prepareSeaportCancel(id, stored.components, offerer)];
    })),
  ]);
  const targets = [...asks.flat(), ...bids.flat(), ...direct];
  const chunks = chunkCancels(targets);
  const twins = targets.filter(target => target.twinOf);
  const client = ctx.chains.client(chainId);
  const estimates = await Promise.all(chunks.map(chunk => client.estimateGas({ account: ctx.account.address, to: SEAPORT_ADDRESS, data: encodeSeaportCancel(chunk.map(target => target.components)), value: 0n }).catch(() => undefined)));
  const fee = await networkFee(ctx.chains, chainId, chunks.map((chunk, i) => ({ shape: { kind: 'cancel', orders: chunk.length }, estimate: estimates[i] })));

  const plan: CancelPlan = { kind: 'cancel', chainId, wallet: offerer, targets };
  const text = [
    `PREVIEW: cancel ${askIds.length} listing(s) and ${bidIds.length} offer(s)${direct.length > 0 ? ` and ${direct.length} signed order(s) the API did not accept` : ''} on ${chainId === 1 ? 'Ethereum' : 'ApeChain'} on-chain via Seaport ${SEAPORT_ADDRESS}.`,
    ...targets.filter(target => !target.twinOf).map(target => `- ${target.id}`),
    twins.length > 0 ? `Also cancels ${twins.length} linked OpenSea listing(s): ${twins.map(target => target.id).join(', ')}.` : '',
    `${chunks.length} transaction(s), gas paid by this wallet.`,
    fee.text,
  ].filter(Boolean);
  return { text: text.join('\n'), plan };
}

export function cancelCount(plan: Pick<CancelPlan, 'targets'>): number {
  return plan.targets.filter(target => !target.twinOf).length;
}

export async function executeCancel(ctx: Ctx, plan: CancelPlan, commit: () => void = () => undefined): Promise<string> {
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  const lines: string[] = [];
  commit();
  for (const chunk of chunkCancels(plan.targets)) {
    const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId: plan.chainId, to: SEAPORT_ADDRESS, data: encodeSeaportCancel(chunk.map(target => target.components)), value: 0n }, new Set());
    const cancelled = cancelledOrderHashes(sent.logs);
    lines.push(`Transaction ${sent.hash} confirmed.`);
    for (const target of chunk) lines.push(`- ${target.id}: ${cancelled.has(target.orderHash) ? 'cancelled' : 'NOT cancelled'}`);
  }
  return lines.join('\n');
}
