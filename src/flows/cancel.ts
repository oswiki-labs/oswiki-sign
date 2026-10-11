import type { Address } from 'viem';

import { networkFee, sendGuardedTx } from '../chain.js';
import { SEAPORT_ADDRESS, type SupportedChainId } from '../constants.js';
import { native, trimAmount, wrapped } from '../format.js';
import { Card, feeValue, feeWarnings, shortHex, type CardPreview } from '../format-card.js';
import { cancelledOrderHashes } from '../seaport/fulfill.js';
import { chunkCancels, encodeSeaportCancel, prepareListingCancels, prepareSeaportCancel, type SeaportCancelTarget } from '../seaport/cancel.js';
import { pickOrderComponents, SEAPORT_ITEM_TYPE, type OrderComponents } from '../seaport/order.js';
import { hashOrderComponents } from '../seaport/sign.js';
import { chainOf, GuardError, me, ORDER_ID_RE, type Ctx } from './common.js';
import { txStep } from './tx-steps.js';

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

export async function previewCancel(ctx: Ctx, input: { chainId: number; askIds?: string[]; bidIds?: string[]; orders?: Array<Record<string, unknown>> }): Promise<CardPreview<CancelPlan>> {
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
  const contracts = [...new Set(targets.map(target => nftOf(target.components)?.token).filter((token): token is string => !!token))];
  const names = new Map(await Promise.all(contracts.map(async contract => [contract, await ctx.api.collection(chainId, contract).then(info => info.name || null, () => null)] as const)));
  const directIds = new Set(direct.map(target => target.id));
  const card = new Card('cancel', chainId);
  for (const target of targets) {
    const what = describeOrder(target.components, chainId, contract => names.get(contract) || shortHex(contract));
    if (target.twinOf) card.row('and its linked OpenSea listing', what.price ?? '', 2);
    else if (directIds.has(target.id)) card.row(`Your signed order the API did not accept: ${what.label}`, what.price ?? '');
    else card.row(`Your ${what.label}`, what.price ?? '');
  }
  card.text('Cancelled on-chain for good: these orders can never be filled again.')
    .rule()
    .row('Transactions', String(chunks.length))
    .row('Network fee', feeValue(fee, chainId));
  for (const warning of feeWarnings(fee)) card.warn(warning);
  card.details([`Seaport ${shortHex(SEAPORT_ADDRESS)}`, ...targets.filter(target => !target.twinOf).slice(0, 3).map(target => shortHex(target.id)), targets.filter(target => !target.twinOf).length > 3 ? `+${targets.filter(target => !target.twinOf).length - 3} more` : null]);
  const note = [
    `Cancelling ${askIds.length} listing(s) and ${bidIds.length} offer(s)${direct.length > 0 ? ` and ${direct.length} signed order(s) the API did not accept` : ''} via Seaport ${SEAPORT_ADDRESS}: ${targets.filter(target => !target.twinOf).map(target => target.id).join(', ')}.`,
    twins.length > 0 ? `Also cancels ${twins.length} linked OpenSea listing(s): ${twins.map(target => target.id).join(', ')}.` : '',
    fee.text,
  ].filter(Boolean);
  return { text: card.render(), plan, note };
}

function nftOf(order: OrderComponents): { token: string; identifier: bigint; itemType: number } | null {
  const offered = order.offer[0];
  const item = offered && offered.itemType >= SEAPORT_ITEM_TYPE.ERC721 ? offered : order.consideration[0];
  if (!item || item.itemType < SEAPORT_ITEM_TYPE.ERC721) return null;
  return { token: item.token.toLowerCase(), identifier: item.identifierOrCriteria, itemType: item.itemType };
}

/** Plain words for one of the wallet's own orders: "listing of X #1 at 1 ETH", "offer on X #1 at 0.5 WETH". */
function describeOrder(order: OrderComponents, chainId: number, nameOf: (contract: string) => string): { label: string; price: string | null } {
  const nft = nftOf(order);
  const offered = order.offer[0];
  if (!nft) return { label: 'order', price: null };
  const isListing = !!offered && offered.itemType >= SEAPORT_ITEM_TYPE.ERC721;
  if (isListing) {
    const total = order.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
    const price = order.consideration.every(item => item.itemType === SEAPORT_ITEM_TYPE.NATIVE) ? native(total, chainId) : `${trimAmount(total)} (token)`;
    return { label: `listing of ${nameOf(nft.token)} #${nft.identifier}`, price };
  }
  const price = offered ? wrapped(offered.startAmount, chainId) : null;
  const target = nft.itemType === SEAPORT_ITEM_TYPE.ERC721_WITH_CRITERIA ? `any ${nameOf(nft.token)} (collection offer)` : `${nameOf(nft.token)} #${nft.identifier}`;
  return { label: `offer on ${target}`, price };
}

export function cancelCount(plan: Pick<CancelPlan, 'targets'>): number {
  return plan.targets.filter(target => !target.twinOf).length;
}

export async function executeCancel(ctx: Ctx, plan: CancelPlan, commit: () => void = () => undefined): Promise<string> {
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  const lines: string[] = [];
  commit();
  const sentLog: string[] = [];
  for (const chunk of chunkCancels(plan.targets)) {
    const sent = await txStep(sentLog, `Cancel ${chunk.map(target => target.id).join(', ')}`, () => sendGuardedTx(ctx.chains, ctx.account, { chainId: plan.chainId, to: SEAPORT_ADDRESS, data: encodeSeaportCancel(chunk.map(target => target.components)), value: 0n }, new Set()));
    const cancelled = cancelledOrderHashes(sent.logs);
    sentLog.push(`Cancel transaction ${sent.hash} confirmed: ${chunk.map(target => `${target.id} ${cancelled.has(target.orderHash) ? 'cancelled' : 'NOT cancelled'}`).join(', ')}.`);
    lines.push(`Transaction ${sent.hash} confirmed.`);
    for (const target of chunk) lines.push(`- ${target.id}: ${cancelled.has(target.orderHash) ? 'cancelled' : 'NOT cancelled'}`);
  }
  return lines.join('\n');
}
