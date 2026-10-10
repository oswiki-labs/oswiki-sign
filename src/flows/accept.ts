import type { Address } from 'viem';

import { sendGuardedTx } from '../chain.js';
import { getOswikiFeeRecipient, SEAPORT_ADDRESS, type SupportedChainId } from '../constants.js';
import { addressLabel, wrapped } from '../format.js';
import { findOfferFulfilledEvent, orderHashFromAskId, revertMessage } from '../seaport/fulfill.js';
import { readConduitApproval, readOnchainRoyalty, readSeaportCounter, royaltySourceLabel, verifyRoyalty, type VerifiedRoyalty } from '../seaport/listing.js';
import { assertOswikiSeaportOffer, encodeOfferAccept, type GuardedOfferAccept } from '../seaport/offer.js';
import { SEAPORT_ITEM_TYPE, type OfferKind } from '../seaport/order.js';
import { ADDRESS_RE, assertCollectionAllowed, assertHolds, chainOf, GuardError, me, ORDER_ID_RE, probeConduit, setApprovalData, TOKEN_ID_RE, type Ctx } from './common.js';
import { applyMinFloor, fetchFloor } from './references.js';

export interface AcceptPlan {
  kind: 'accept';
  chainId: SupportedChainId;
  wallet: Address;
  bidId: string;
  maker: Address;
  contract: Address;
  tokenId: string;
  offerKind: OfferKind;
  isErc1155: boolean;
  offerWei: bigint;
  sellerNetWei: bigint;
  royaltyRecipient: Address | null;
}

function royaltyLeg(guarded: GuardedOfferAccept, chainId: SupportedChainId): { recipient: Address | null; wei: bigint } {
  const fee = getOswikiFeeRecipient(chainId).toLowerCase();
  const leg = guarded.bidOrder.consideration.slice(1).find(entry => entry.recipient !== fee);
  return leg ? { recipient: leg.recipient.toLowerCase() as Address, wei: leg.startAmount } : { recipient: null, wei: 0n };
}

/** The bidder's royalty leg comes out of the seller's payout: ERC-2981 when the collection has it, else labelled unverified and capped. */
async function checkAcceptRoyalty(ctx: Ctx, chainId: SupportedChainId, guarded: GuardedOfferAccept, tokenId: string): Promise<VerifiedRoyalty> {
  const leg = royaltyLeg(guarded, chainId);
  if (leg.recipient === null || leg.wei === 0n) return { recipient: null, wei: 0n, source: 'none' };
  const onchain = await readOnchainRoyalty(ctx.chains.client(chainId), guarded.contract, tokenId, guarded.amounts.offerWei);
  return verifyRoyalty({ recipient: leg.recipient, wei: leg.wei, totalWei: guarded.amounts.offerWei, quantity: 1n }, onchain, null, (reason) => {
    throw new GuardError(`The offer's royalty did not pass a safety check (${reason}). Nothing was sent.`);
  }, false);
}

async function loadAccept(ctx: Ctx, chainId: SupportedChainId, bidId: string, tokenId: string): Promise<{ guarded: GuardedOfferAccept; maker: Address; offerKind: OfferKind }> {
  const meta = await ctx.api.bid(chainId, bidId);
  if (!ADDRESS_RE.test(meta.maker) || !ADDRESS_RE.test(meta.contract)) throw new GuardError(`Offer ${bidId} has no readable maker or collection.`);
  const offerKind: OfferKind | null = meta.kind === 'single-token' || meta.kind === 'item' ? 'item' : meta.kind === 'collection' ? 'collection' : null;
  if (!offerKind) throw new GuardError(`Offer ${bidId} is a "${meta.kind.slice(0, 30)}" offer, which this signer does not accept.`);
  if (offerKind === 'item' && meta.tokenId !== tokenId) throw new GuardError(`Offer ${bidId} is for token #${meta.tokenId}, not #${tokenId}.`);
  const maker = meta.maker.toLowerCase() as Address;
  const [data, counter] = await Promise.all([
    ctx.api.acceptData(chainId, bidId, me(ctx), tokenId),
    readSeaportCounter(ctx.chains.client(chainId), maker),
  ]);
  const guarded = assertOswikiSeaportOffer(data, { chainId, bidId, maker, fulfiller: me(ctx), contract: meta.contract, tokenId, kind: offerKind, counter, nowSeconds: Math.floor(ctx.now() / 1000) });
  return { guarded, maker, offerKind };
}

export async function previewAcceptOffer(ctx: Ctx, input: { chainId: number; bidId: string; tokenId: string; allowNoFloor?: boolean }): Promise<{ text: string; plan: AcceptPlan }> {
  const chainId = chainOf(input.chainId);
  if (typeof input.bidId !== 'string' || !ORDER_ID_RE.test(input.bidId)) throw new GuardError('bidId must look like "oswiki-0x...".');
  if (typeof input.tokenId !== 'string' || !TOKEN_ID_RE.test(input.tokenId)) throw new GuardError('tokenId must be a decimal token id.');
  const { guarded, maker, offerKind } = await loadAccept(ctx, chainId, input.bidId, input.tokenId);
  assertCollectionAllowed(ctx.config, guarded.contract);
  if (maker === me(ctx)) throw new GuardError('This is your own offer.');

  const client = ctx.chains.client(chainId);
  const isErc1155 = guarded.bidOrder.consideration[0]!.itemType === SEAPORT_ITEM_TYPE.ERC1155;
  const item = { contract: guarded.contract, tokenId: input.tokenId, isErc1155, quantity: 1n };
  await assertHolds(client, me(ctx), item);
  const [approved, probe, { floor }] = await Promise.all([
    readConduitApproval(client, guarded.contract, me(ctx)),
    probeConduit(client, me(ctx), item),
    fetchFloor(ctx, chainId, guarded.contract),
  ]);
  if (probe === 'blocked') throw new GuardError('This collection blocks transfers through the OpenSea conduit, so the offer cannot be accepted here.');
  const floorNote = applyMinFloor(floor, guarded.amounts.sellerNetWei, ctx.config.minListFloorPct, chainId, 'Your payout from this offer', input.allowNoFloor === true);
  const royalty = await checkAcceptRoyalty(ctx, chainId, guarded, input.tokenId);

  let simulation = 'The fill is simulated right before sending, after the approval.';
  if (approved) {
    try {
      await client.call({ account: ctx.account.address, to: SEAPORT_ADDRESS, data: encodeOfferAccept(guarded), value: 0n });
      simulation = 'The simulation passed just now.';
    } catch (err) {
      throw new GuardError(`Accepting would fail: ${revertMessage(err)}. Nothing was sent.`);
    }
  }

  const plan: AcceptPlan = {
    kind: 'accept',
    chainId,
    wallet: me(ctx),
    bidId: input.bidId,
    maker,
    contract: guarded.contract,
    tokenId: input.tokenId,
    offerKind,
    isErc1155,
    offerWei: guarded.amounts.offerWei,
    sellerNetWei: guarded.amounts.sellerNetWei,
    royaltyRecipient: royalty.recipient,
  };
  const text = [
    `PREVIEW: accept ${offerKind} offer ${input.bidId} from ${maker}: sell ${guarded.contract} #${input.tokenId} on ${chainId === 1 ? 'Ethereum' : 'ApeChain'}.`,
    `- Offer ${wrapped(guarded.amounts.offerWei, chainId)}, fee ${wrapped(guarded.amounts.feeWei, chainId)}, royalty ${wrapped(guarded.amounts.royaltyWei, chainId)}: you receive ${wrapped(guarded.amounts.sellerNetWei, chainId)}.`,
    royalty.recipient ? `- Royalty ${wrapped(royalty.wei, chainId)} to ${addressLabel(royalty.recipient)}, ${royaltySourceLabel(royalty.source)}.` : '- No royalty.',
    approved ? '- No approval needed.' : `- First approves the OpenSea conduit on ${guarded.contract} (one transaction).`,
    floor.warning ?? '',
    floorNote ? `NOTE: ${floorNote}` : '',
    `One transaction to Seaport ${SEAPORT_ADDRESS}. ${simulation}`,
  ].filter(Boolean);
  return { text: text.join('\n'), plan };
}

export async function executeAcceptOffer(ctx: Ctx, plan: AcceptPlan, commit: () => void): Promise<string> {
  const { chainId } = plan;
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  const { guarded, maker } = await loadAccept(ctx, chainId, plan.bidId, plan.tokenId);
  if (maker !== plan.maker || guarded.contract !== plan.contract || guarded.amounts.sellerNetWei !== plan.sellerNetWei || guarded.amounts.offerWei !== plan.offerWei || royaltyLeg(guarded, chainId).recipient !== plan.royaltyRecipient) {
    throw new GuardError('The offer changed since the preview. Run the preview again.');
  }
  assertCollectionAllowed(ctx.config, guarded.contract);
  const client = ctx.chains.client(chainId);
  const item = { contract: guarded.contract, tokenId: plan.tokenId, isErc1155: plan.isErc1155, quantity: 1n };
  await assertHolds(client, me(ctx), item);
  const approved = await readConduitApproval(client, guarded.contract, me(ctx));
  const nftContracts = new Set([guarded.contract]);
  const log: string[] = [];

  commit();
  if (!approved) {
    const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId, to: guarded.contract, data: setApprovalData(), value: 0n }, nftContracts);
    log.push(`Approved the OpenSea conduit on ${guarded.contract} (tx ${sent.hash}).`);
    if (await probeConduit(client, me(ctx), item) === 'blocked') throw new GuardError('This collection blocks transfers through the OpenSea conduit; the offer was not accepted.');
  }
  const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId, to: SEAPORT_ADDRESS, data: encodeOfferAccept(guarded), value: 0n }, nftContracts);
  const filled = findOfferFulfilledEvent(sent.logs, orderHashFromAskId(plan.bidId)!, { token: guarded.contract, identifier: BigInt(plan.tokenId) });
  log.push(filled
    ? `Sold ${guarded.contract} #${plan.tokenId} for ${wrapped(plan.sellerNetWei, chainId)} net (tx ${sent.hash}).`
    : `Transaction ${sent.hash} confirmed but did not fill this offer.`);
  return log.join('\n');
}
