import { encodeFunctionData, type Address } from 'viem';

import { WRAPPED_NATIVE_ABI } from '../abi.js';
import { ApiError } from '../api.js';
import { sendGuardedTx } from '../chain.js';
import { getOswikiFeeRecipient, NATIVE_SYMBOL, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_ADDRESS, ZERO_BYTES32, type SupportedChainId } from '../constants.js';
import { native, parsePositiveAmount, wrapped } from '../format.js';
import {
  assertOfferRequirements,
  MAX_OFFERS_PER_REQUEST,
  OfferRequirementsError,
  readOfferFunding,
  type OfferItemRequest,
} from '../seaport/offer.js';
import { REQUIRED_FEE_BPS } from '../seaport/listing.js';
import { buildOfferOrder, serializeOrderComponents, type OfferKind, type OrderComponents } from '../seaport/order.js';
import { signSeaportBulkOrders, signSeaportOrder, type SignedSeaportOrder } from '../seaport/sign.js';
import { ADDRESS_RE, assertBuyingEnabled, assertCollectionAllowed, assertMaxBuy, chainOf, GuardError, me, readIsErc1155, RejectedOrderError, rejectedOrdersText, TOKEN_ID_RE, unacceptedIndexes, type Ctx } from './common.js';

export interface OfferInput {
  chainId: number;
  contract: string;
  tokenId?: string;
  price: unknown;
  quantity?: number;
  durationDays?: number;
}

export interface OfferPlan {
  kind: 'offer';
  chainId: SupportedChainId;
  wallet: Address;
  offerKind: OfferKind;
  contract: Address;
  tokenId: string | null;
  amountWei: bigint;
  quantity: number;
  counter: bigint;
  wrapWei: bigint;
  requiredAllowanceWei: bigint;
  orders: OrderComponents[];
}

const DEFAULT_OFFER_DAYS = 7;

/** Last check before an offer is signed: WETH/WAPE to Seaport only (conduit 0), zone 0, fixed amount. */
function assertOwnOffer(order: OrderComponents, plan: Pick<OfferPlan, 'chainId' | 'wallet' | 'contract' | 'amountWei'>): void {
  const currency = WRAPPED_NATIVE[plan.chainId];
  const fail = (reason: string): never => {
    throw new OfferRequirementsError(reason);
  };
  if (order.offerer !== plan.wallet) fail('offerer is not this wallet');
  if (order.zone !== ZERO_ADDRESS || order.conduitKey !== ZERO_BYTES32 || order.orderType !== 0) fail('unexpected order type');
  if (order.offer.length !== 1 || order.offer[0]!.token !== currency || order.offer[0]!.startAmount !== plan.amountWei || order.offer[0]!.endAmount !== plan.amountWei) fail('offer must be the exact wrapped amount');
  if (order.consideration[0]?.token !== plan.contract || order.consideration[0]?.recipient !== plan.wallet) fail('the NFT must come to this wallet');
  const fee = order.consideration[1];
  const expectedFee = (plan.amountWei * BigInt(REQUIRED_FEE_BPS)) / 10000n;
  if (!fee || fee.token !== currency || fee.recipient !== getOswikiFeeRecipient(plan.chainId).toLowerCase() || fee.startAmount !== expectedFee || expectedFee <= 0n) fail('the OSWiki fee leg must be exactly 1% to the known fee recipient');
}

/** Own active OSWiki offers from /v1/bids, null when they cannot be added up. */
async function ownOpenOffersWei(ctx: Ctx, chainId: SupportedChainId, maker: Address): Promise<bigint | null> {
  try {
    const bids = await ctx.api.allMakerBids(chainId, maker);
    let sum = 0n;
    for (const bid of bids) {
      if (bid.priceWei === null || bid.priceWei === undefined) return null;
      sum += bid.priceWei;
    }
    return sum;
  } catch {
    return null;
  }
}

/** Own open offers (or, if unknown, the allowance already granted) + this offer, never above balance + this offer. */
export function boundedAllowance(input: { openOffersWei: bigint | null; currentAllowance: bigint; wrappedBalance: bigint; totalWei: bigint }): bigint {
  const wanted = (input.openOffersWei ?? input.currentAllowance) + input.totalWei;
  const cap = input.wrappedBalance + input.totalWei;
  return wanted < cap ? wanted : cap;
}

export async function previewOffer(ctx: Ctx, input: OfferInput): Promise<{ text: string; plan: OfferPlan }> {
  const chainId = chainOf(input.chainId);
  assertBuyingEnabled(ctx.config, chainId);
  if (typeof input.contract !== 'string' || !ADDRESS_RE.test(input.contract)) throw new GuardError('contract must be a 0x address.');
  const contract = input.contract.toLowerCase() as Address;
  assertCollectionAllowed(ctx.config, contract);
  const offerKind: OfferKind = input.tokenId === undefined || input.tokenId === null || input.tokenId === '' ? 'collection' : 'item';
  if (offerKind === 'item' && !TOKEN_ID_RE.test(String(input.tokenId))) throw new GuardError('tokenId must be a decimal token id.');
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_OFFERS_PER_REQUEST) throw new GuardError(`quantity must be 1 to ${MAX_OFFERS_PER_REQUEST}.`);
  if (offerKind === 'item' && quantity !== 1) throw new GuardError('An item offer is for one token; use a collection offer (no tokenId) for several.');
  const amountWei = parsePositiveAmount(input.price, 'price');
  const days = input.durationDays ?? DEFAULT_OFFER_DAYS;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || days > 365) throw new GuardError('durationDays must be more than 0 and at most 365.');
  const seconds = Math.max(3600, Math.min(Math.round(days * 86400), 365 * 86400));
  const total = amountWei * BigInt(quantity);
  assertMaxBuy(ctx.config, chainId, total, 'This offer');

  const offerer = me(ctx);
  const tokenId = offerKind === 'item' ? String(input.tokenId) : null;
  const items: OfferItemRequest[] = [{ kind: offerKind, contract, tokenId, amountWei, quantity }];
  const client = ctx.chains.client(chainId);
  const [requirements, funding, isErc1155, openOffers] = await Promise.all([
    ctx.api.offerRequirements({ chainId, maker: offerer, items: [{ kind: offerKind, contract, tokenId, amountWei: amountWei.toString(), quantity }] }),
    readOfferFunding(client, chainId, offerer),
    readIsErc1155(client, contract),
    ownOpenOffersWei(ctx, chainId, offerer),
  ]);
  const checked = assertOfferRequirements(requirements, { chainId, maker: offerer, items });
  const requirement = checked.items[0]!;
  if (requirement.isErc1155 !== isErc1155) throw new OfferRequirementsError('token standard mismatch');
  if (offerKind === 'collection' && isErc1155) throw new GuardError('Collection offers are ERC-721 only.');

  const wrapWei = funding.wrappedBalance < total ? total - funding.wrappedBalance : 0n;
  if (wrapWei > 0n && funding.nativeBalance < wrapWei) {
    throw new GuardError(`Not enough ${NATIVE_SYMBOL[chainId]} to wrap: the offer needs ${wrapped(total, chainId)}, the wallet has ${wrapped(funding.wrappedBalance, chainId)} and ${native(funding.nativeBalance, chainId)}.`);
  }
  const requiredAllowanceWei = boundedAllowance({ openOffersWei: openOffers, currentAllowance: funding.allowance, wrappedBalance: funding.wrappedBalance, totalWei: total });
  const approve = funding.allowance < requiredAllowanceWei;

  const orders = Array.from({ length: quantity }, () => buildOfferOrder({
    offerer,
    kind: offerKind,
    token: contract,
    tokenId,
    isErc1155,
    currency: checked.currency,
    amountWei,
    feeWei: requirement.feeWeiBig,
    feeRecipient: checked.feeRecipient,
    royaltyRecipient: requirement.royaltyRecipient,
    royaltyWei: requirement.royaltyWeiBig,
    counter: funding.counter,
    durationSeconds: seconds,
    nowSeconds: Math.floor(ctx.now() / 1000),
  }));
  const plan: OfferPlan = { kind: 'offer', chainId, wallet: offerer, offerKind, contract, tokenId, amountWei, quantity, counter: funding.counter, wrapWei, requiredAllowanceWei, orders };
  for (const order of orders) assertOwnOffer(order, plan);

  const text = [
    `PREVIEW: ${offerKind === 'item' ? `offer on ${contract} #${tokenId}` : `${quantity} collection offer${quantity === 1 ? '' : 's'} on ${contract} (any token)`} on ${chainId === 1 ? 'Ethereum' : 'ApeChain'}, valid ${Math.round(seconds / 86400 * 10) / 10} days.`,
    `- ${wrapped(amountWei, chainId)} each${quantity > 1 ? `, ${wrapped(total, chainId)} in total` : ''}. A seller receives ${wrapped(requirement.sellerNetWeiBig, chainId)} (fee ${wrapped(requirement.feeWeiBig, chainId)}, royalty ${wrapped(requirement.royaltyWeiBig, chainId)}).`,
    wrapWei > 0n ? `- Wrap ${native(wrapWei, chainId)} into ${wrapped(wrapWei, chainId)} first (one transaction).` : `- No wrap needed (${wrapped(funding.wrappedBalance, chainId)} available).`,
    approve
      ? `- Approve exactly ${wrapped(requiredAllowanceWei, chainId)} to Seaport ${SEAPORT_ADDRESS} (${openOffers === null ? 'your open offers could not be loaded: current allowance' : `your open OSWiki offers ${wrapped(openOffers, chainId)}`} + this one, capped at your balance + this one; never unlimited).`
      : '- No approval needed.',
    'Signing the offer is free; it can be accepted by any holder until it expires or is cancelled.',
  ];
  return { text: text.join('\n'), plan };
}

export async function executeOffer(ctx: Ctx, plan: OfferPlan, commit: () => void): Promise<string> {
  const { chainId } = plan;
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  assertCollectionAllowed(ctx.config, plan.contract);
  const total = plan.amountWei * BigInt(plan.quantity);
  assertMaxBuy(ctx.config, chainId, total, 'This offer');
  for (const order of plan.orders) assertOwnOffer(order, plan);

  const funding = await readOfferFunding(ctx.chains.client(chainId), chainId, plan.wallet);
  if (funding.counter !== plan.counter) throw new GuardError('Your Seaport counter changed since the preview. Run the preview again.');
  const shortfall = funding.wrappedBalance < total ? total - funding.wrappedBalance : 0n;
  if (shortfall > plan.wrapWei) throw new GuardError('Your wrapped balance dropped since the preview. Run the preview again.');
  if (shortfall > 0n && funding.nativeBalance < shortfall) throw new GuardError(`Not enough ${NATIVE_SYMBOL[chainId]} to wrap.`);

  const currency = WRAPPED_NATIVE[chainId]!;
  const log: string[] = [];
  commit();
  if (shortfall > 0n) {
    const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId, to: currency, data: encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'deposit' }), value: shortfall }, new Set());
    log.push(`Wrapped ${native(shortfall, chainId)} (tx ${sent.hash}).`);
  }
  if (funding.allowance < plan.requiredAllowanceWei) {
    const data = encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'approve', args: [SEAPORT_ADDRESS, plan.requiredAllowanceWei] });
    const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId, to: currency, data, value: 0n }, new Set());
    log.push(`Approved exactly ${wrapped(plan.requiredAllowanceWei, chainId)} to Seaport (tx ${sent.hash}).`);
  }

  const signed: SignedSeaportOrder[] = plan.orders.length === 1
    ? [await signSeaportOrder(ctx.account, plan.orders[0]!, { chainId })]
    : await signSeaportBulkOrders(ctx.account, plan.orders, { chainId });
  const payloads = signed.map(entry => ({ parameters: serializeOrderComponents(entry.order), signature: entry.signature, orderHash: entry.orderHash }));
  const rejected = (what: string, reason: string, indexes: number[]) => new RejectedOrderError([...log, rejectedOrdersText(chainId, what, reason, indexes.map(i => signed[i]!.order))].join('\n'));
  const reasonOf = (err: unknown) => (err instanceof ApiError ? err.message : 'the request failed');
  if (payloads.length === 1) {
    let created;
    try {
      created = await ctx.api.createBid(chainId, payloads[0]!);
    } catch (err) {
      throw rejected(`the signed offer oswiki-${signed[0]!.orderHash}`, reasonOf(err), [0]);
    }
    log.push(`Offer placed: ${created.bidId ?? `oswiki-${signed[0]!.orderHash}`}.`);
  } else {
    let result;
    try {
      result = await ctx.api.createBidsBulk(chainId, payloads.map(seaport => ({ seaport })));
    } catch (err) {
      throw rejected(`the ${payloads.length} signed offers`, reasonOf(err), payloads.map((_, i) => i));
    }
    log.push(`Placed ${result.created} of ${payloads.length} offers${result.failed > 0 ? `, ${result.failed} rejected` : ''}.`);
    for (const failure of result.results.filter(entry => !entry.success)) log.push(`- rejected: ${failure.message ?? failure.code ?? 'unknown reason'}`);
    const missing = unacceptedIndexes(signed, result, 'bidId');
    if (missing.length > 0) throw rejected(`${missing.length} of the signed offers`, 'see the rejections above', missing);
  }
  return log.join('\n');
}
