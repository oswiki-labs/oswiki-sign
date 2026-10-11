import type { Address } from 'viem';

import { ApiError } from '../api.js';
import { sendGuardedTx } from '../chain.js';
import { getOswikiFeeRecipient, OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, ZERO_ADDRESS, type SupportedChainId } from '../constants.js';
import { native, parsePositiveAmount } from '../format.js';
import { bpsLabel, Card, inDays, percentLabel, shortHex, type CardPreview } from '../format-card.js';
import { cancelledOrderHashes } from '../seaport/fulfill.js';
import { chunkCancels, encodeSeaportCancel, prepareListingCancels, type SeaportCancelTarget } from '../seaport/cancel.js';
import {
  assertSeaportRequirements,
  checkRoyaltyCap,
  ListingRequirementsError,
  MAX_LISTINGS_PER_REQUEST,
  MAX_ROYALTY_BPS,
  readConduitApproval,
  readOnchainRoyalty,
  readSeaportCounter,
  requirementFor,
  REQUIRED_FEE_BPS,
  royaltySourceLabel,
  UNVERIFIED_ROYALTY_LABEL,
  verifyListingRoyalty,
} from '../seaport/listing.js';
import { applyOpenSeaMarkup, assertOpenSeaTwin, assertTwinCreatorFees, buildOpenSeaOrder, OpenSeaTwinError, usableOpenSeaTerms, type TwinRoyalty } from '../seaport/opensea.js';
import { buildListingOrder, computeSeaportAmounts, SEAPORT_ITEM_TYPE, serializeOrderComponents, type OrderComponents } from '../seaport/order.js';
import { signSeaportBulkOrders, signSeaportOrder, type SignedSeaportOrder } from '../seaport/sign.js';
import {
  ADDRESS_RE,
  assertCollectionAllowed,
  assertHolds,
  chainOf,
  GuardError,
  me,
  probeConduit,
  readIsErc1155,
  RejectedOrderError,
  rejectedOrdersText,
  setApprovalData,
  TOKEN_ID_RE,
  unacceptedIndexes,
  type Ctx,
} from './common.js';
import { applyMinFloor, belowFloor, belowFloorLabel, checkListingPrice, fetchCollectionReferences, type CollectionReferences } from './references.js';
import { afterSends, txStep } from './tx-steps.js';

export interface ListingInput {
  chainId: number;
  items: Array<{ contract: string; tokenId: string; price: unknown; quantity?: number }>;
  durationDays?: number;
  crossListOpenSea?: boolean;
  openSeaMarkupBps?: number;
  allowNoFloor?: boolean;
}

export interface ListingPlan {
  kind: 'listing';
  chainId: SupportedChainId;
  wallet: Address;
  counter: bigint;
  items: Array<{ contract: Address; tokenId: string; isErc1155: boolean; quantity: bigint; unitPriceWei: bigint }>;
  approvals: Address[];
  cancels: SeaportCancelTarget[];
  orders: OrderComponents[];
  twins: Array<OrderComponents | null>;
  twinRoyalties: TwinRoyalty[];
  sellWei: bigint;
  belowFloorWei: bigint;
}

const DEFAULT_DURATION_DAYS = 30;

function durationSeconds(days: number | undefined): number {
  const value = days ?? DEFAULT_DURATION_DAYS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 365) throw new GuardError('durationDays must be more than 0 and at most 365.');
  const seconds = Math.round(value * 86400);
  if (seconds < 3600) throw new GuardError('The listing duration must be at least 1 hour.');
  return Math.min(seconds, 365 * 86400);
}

function orderTotal(order: OrderComponents): bigint {
  return order.consideration.reduce((sum, item) => sum + item.startAmount, 0n);
}

function sameListedItem(order: OrderComponents, contract: string, tokenId: string): boolean {
  const offer = order.offer[0];
  return order.offer.length === 1 && !!offer && offer.itemType === SEAPORT_ITEM_TYPE.ERC721 && offer.token === contract.toLowerCase() && offer.identifierOrCriteria === BigInt(tokenId);
}

/** Last check before a listing is signed: our own layout, our fee recipient, bounded fee and royalty. */
export function assertOwnListingOrder(order: OrderComponents, expected: { chainId: number; offerer: string; contract: string; tokenId: string; quantity: bigint; unitPriceWei: bigint }): void {
  const fail = (reason: string): never => {
    throw new ListingRequirementsError(reason);
  };
  const offerer = expected.offerer.toLowerCase();
  if (order.offerer !== offerer) fail('offerer is not this wallet');
  if (order.zone !== ZERO_ADDRESS) fail('zone must be 0');
  if (order.conduitKey !== OPENSEA_CONDUIT_KEY) fail('unexpected conduit key');
  if (order.offer.length !== 1) fail('exactly one offer item');
  const offer = order.offer[0]!;
  if (offer.token !== expected.contract.toLowerCase() || offer.identifierOrCriteria !== BigInt(expected.tokenId) || offer.startAmount !== expected.quantity || offer.endAmount !== expected.quantity) fail('offer is not the listed NFT');
  const total = orderTotal(order);
  if (total !== expected.unitPriceWei * expected.quantity) fail('total is not the requested price');
  const [seller, ...legs] = order.consideration;
  if (!seller || seller.recipient !== offerer) fail('first payment must go to this wallet');
  if (legs.length > 2) fail('too many payment legs');
  const feeRecipient = getOswikiFeeRecipient(expected.chainId).toLowerCase();
  for (const leg of order.consideration) {
    if (leg.itemType !== 0 || leg.token !== ZERO_ADDRESS || leg.startAmount !== leg.endAmount || leg.startAmount <= 0n) fail('payments must be fixed native amounts');
  }
  const fee = legs[0];
  const expectedFee = ((expected.unitPriceWei * BigInt(REQUIRED_FEE_BPS)) / 10000n) * expected.quantity;
  if (!fee || fee.recipient !== feeRecipient || fee.startAmount !== expectedFee || expectedFee <= 0n) fail('the OSWiki fee leg must be exactly 1% to the known fee recipient');
  for (const leg of legs.slice(1)) {
    if (leg.recipient === feeRecipient) fail('fee leg out of place');
    if (leg.startAmount * 10000n > total * BigInt(MAX_ROYALTY_BPS)) fail('royalty too high');
  }
}

export async function previewListing(ctx: Ctx, input: ListingInput): Promise<CardPreview<ListingPlan>> {
  const chainId = chainOf(input.chainId);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new GuardError('Nothing to list.');
  if (input.items.length > MAX_LISTINGS_PER_REQUEST) throw new GuardError(`At most ${MAX_LISTINGS_PER_REQUEST} items per listing.`);
  const seconds = durationSeconds(input.durationDays);
  const markupBps = input.openSeaMarkupBps ?? 0;
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > 10000) throw new GuardError('openSeaMarkupBps must be a whole number from 0 to 10000.');

  const offerer = me(ctx);
  const seen = new Set<string>();
  const parsed = input.items.map((item, i) => {
    if (typeof item.contract !== 'string' || !ADDRESS_RE.test(item.contract)) throw new GuardError(`items[${i}].contract must be a 0x address.`);
    if (typeof item.tokenId !== 'string' || !TOKEN_ID_RE.test(item.tokenId)) throw new GuardError(`items[${i}].tokenId must be a decimal token id.`);
    const contract = item.contract.toLowerCase() as Address;
    const key = `${contract}:${item.tokenId}`;
    if (seen.has(key)) throw new GuardError(`${key} is listed twice.`);
    seen.add(key);
    assertCollectionAllowed(ctx.config, contract);
    const unitPriceWei = parsePositiveAmount(item.price, `items[${i}].price`);
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new GuardError(`items[${i}].quantity must be a whole number of at least 1.`);
    return { contract, tokenId: item.tokenId, unitPriceWei, quantity: BigInt(quantity) };
  });

  const client = ctx.chains.client(chainId);
  const contracts = [...new Set(parsed.map(item => item.contract))];
  const [counter, standards, approvals, params, references, myListings] = await Promise.all([
    readSeaportCounter(client, offerer),
    Promise.all(contracts.map(contract => readIsErc1155(client, contract))),
    Promise.all(contracts.map(contract => readConduitApproval(client, contract, offerer))),
    ctx.api.orderParams(chainId).catch(() => null),
    Promise.all(contracts.map(contract => fetchCollectionReferences(ctx, chainId, contract, parsed.filter(item => item.contract === contract).map(item => item.tokenId)))),
    ctx.api.makerListings(chainId, offerer).catch(() => null),
  ]);
  const erc1155 = new Map(contracts.map((contract, i) => [contract, standards[i]!]));
  const refsBy = new Map<string, CollectionReferences>(contracts.map((contract, i) => [contract, references[i]!]));

  const items = parsed.map(item => {
    const isErc1155 = erc1155.get(item.contract)!;
    if (!isErc1155 && item.quantity !== 1n) throw new GuardError(`${item.contract} is ERC-721: quantity must be 1.`);
    return { ...item, isErc1155 };
  });
  await Promise.all(items.map(item => assertHolds(client, offerer, item)));

  const requirements = await ctx.api.listingRequirements({
    chainId,
    maker: offerer,
    items: items.map(item => ({ contract: item.contract, tokenId: item.tokenId, quantity: Number(item.quantity), unitPriceWei: item.unitPriceWei.toString() })),
  });
  assertSeaportRequirements(requirements, chainId, items.length);

  const probes = await Promise.all(contracts.map(contract => {
    const first = items.find(item => item.contract === contract)!;
    return probeConduit(client, offerer, first);
  }));
  const blocked = contracts.filter((contract, i) => probes[i] === 'blocked');
  const onchainRoyalties = await Promise.all(items.map(item => readOnchainRoyalty(client, item.contract, item.tokenId, item.unitPriceWei * item.quantity)));

  const notes: string[] = [];
  const aiNotes: string[] = [];
  const orders: OrderComponents[] = [];
  const twins: Array<OrderComponents | null> = [];
  const twinRoyalties: TwinRoyalty[] = [];
  const nameOf = (contract: string) => refsBy.get(contract)?.info?.name || shortHex(contract);
  const card = new Card(items.length === 1 ? 'listing' : `listing of ${items.length} items`, chainId);
  let totalSeller = 0n;
  let totalListed = 0n;
  let belowFloorWei = 0n;
  for (const [index, item] of items.entries()) {
    const requirement = requirementFor(requirements, item.contract, item.tokenId);
    if (requirement.blocked || blocked.includes(item.contract)) throw new GuardError(`${item.contract} only trades through OpenSea's own zone and cannot be listed on OSWiki. Nothing was signed.`);
    const totalWei = item.unitPriceWei * item.quantity;
    checkRoyaltyCap(requirement, totalWei);
    if (params?.minUnitPriceWei && item.unitPriceWei < params.minUnitPriceWei) {
      throw new GuardError(`The price ${native(item.unitPriceWei, chainId)} is below the minimum of ${native(params.minUnitPriceWei, chainId)}.`);
    }
    const refs = refsBy.get(item.contract)!;
    const floorNote = applyMinFloor(refs.floor, item.unitPriceWei, ctx.config.minListFloorPct, chainId, `The price for #${item.tokenId}`, input.allowNoFloor === true);
    const amounts = computeSeaportAmounts({
      unitPriceWei: item.unitPriceWei,
      quantity: item.quantity,
      feeBps: requirements.feeBps,
      royaltyWei: BigInt(requirement.royaltyWei),
      royaltyRecipient: requirement.royaltyRecipient,
      offerer,
    });
    const royalty = verifyListingRoyalty(
      { recipient: amounts.royaltyRecipient, wei: amounts.royalty, totalWei, quantity: item.quantity },
      onchainRoyalties[index] ?? null,
      refs.info?.royalty ?? null,
    );
    const twinRoyalty: TwinRoyalty = { recipient: royalty.recipient, wei: royalty.wei, totalWei };
    const order = buildListingOrder({
      offerer,
      token: item.contract,
      tokenId: item.tokenId,
      isErc1155: item.isErc1155,
      quantity: item.quantity,
      unitPriceWei: item.unitPriceWei,
      feeBps: requirements.feeBps,
      feeRecipient: requirements.feeRecipient,
      royaltyRecipient: requirement.royaltyRecipient,
      royaltyWei: BigInt(requirement.royaltyWei),
      counter,
      durationSeconds: seconds,
      nowSeconds: Math.floor(ctx.now() / 1000),
    });
    assertOwnListingOrder(order, { chainId, offerer, contract: item.contract, tokenId: item.tokenId, quantity: item.quantity, unitPriceWei: item.unitPriceWei });
    orders.push(order);

    const check = checkListingPrice(refs, { chainId, contract: item.contract, tokenId: item.tokenId, unitPriceWei: item.unitPriceWei, nowMs: ctx.now() });
    totalSeller += amounts.seller;
    totalListed += totalWei;
    card.row(`${nameOf(item.contract)} #${item.tokenId}${item.isErc1155 ? ` ×${item.quantity}` : ''}`, native(totalWei, chainId));
    card.row(`OSWiki fee ${bpsLabel(requirements.feeBps)}`, `−${native(amounts.fee, chainId)}`, 2);
    if (royalty.recipient) {
      card.row(`Royalty ${percentLabel(royalty.wei, totalWei)} → ${shortHex(royalty.recipient)}`, `−${native(royalty.wei, chainId)}`, 2);
      if (royalty.source === 'ERC-2981') card.text('✓ matches on-chain ERC-2981 royaltyInfo', 4);
      else card.warn(`Royalty ${UNVERIFIED_ROYALTY_LABEL}.`, 2);
    } else {
      card.row('Royalty', 'none', 2);
    }
    card.row('You receive', native(amounts.seller, chainId), 2);
    card.text(`Reference: ${check.references}`, 2);
    for (const warning of check.warnings) card.warn(warning, 2);
    if (floorNote) card.warn(floorNote, 2);
    const below = belowFloor(refs.floor.wei, item.unitPriceWei) * item.quantity;
    belowFloorWei += below;
    if (below > 0n) card.text(belowFloorLabel(refs.floor.wei, below, chainId), 2);
    aiNotes.push(`${item.contract} #${item.tokenId}: ${royalty.recipient ? `royalty ${native(royalty.wei, chainId)} to ${royalty.recipient}, ${royaltySourceLabel(royalty.source)}` : 'no royalty'}.`);

    let twin: OrderComponents | null = null;
    if (input.crossListOpenSea) {
      const terms = usableOpenSeaTerms(requirement.opensea ?? null, chainId);
      let reason = 'OpenSea\'s terms for this collection are missing or failed the safety check (Seaport, conduit, OpenSea fee recipient, fee at most 1%, known zone)';
      if (terms) {
        try {
          assertTwinCreatorFees(terms, twinRoyalty, offerer);
          twin = buildOpenSeaOrder(order, terms, undefined, markupBps);
          describeTwin(card, aiNotes, twin, order, twinRoyalty, chainId, markupBps, royalty.source === 'ERC-2981');
        } catch (err) {
          twin = null;
          reason = err instanceof OpenSeaTwinError ? err.message : 'the OpenSea order could not be priced';
        }
      }
      if (!twin) card.warn(`#${item.tokenId}: NOT cross-listed on OpenSea (${reason}). It is listed on OSWiki only.`, 2);
    }
    twins.push(twin);
    twinRoyalties.push(twinRoyalty);
  }

  const cancels: SeaportCancelTarget[] = [];
  const cancelLines: Array<Array<[string, string]>> = [];
  if (myListings === null && items.some(item => !item.isErc1155)) {
    notes.push('Could not load your existing listings: a cheaper older listing of the same token would stay fillable. Check them with my_listings.');
  }
  for (const item of items.filter(entry => !entry.isErc1155)) {
    const mine = (myListings ?? []).filter(listing => listing.contract === item.contract && listing.tokenId === item.tokenId);
    const name = nameOf(item.contract);
    for (const listing of mine) {
      let targets: SeaportCancelTarget[];
      try {
        const stored = await ctx.api.askComponents(chainId, listing.id);
        targets = prepareListingCancels(listing.id, stored.components, stored.twin, offerer);
      } catch {
        notes.push(`Could not verify your existing listing ${shortHex(listing.id)} of #${item.tokenId}, so it is NOT cancelled; if it is cheaper it stays fillable. Check it with my_listings.`);
        continue;
      }
      const verified = targets.filter(target => sameListedItem(target.components, item.contract, item.tokenId));
      const main = verified[0];
      if (!main || main.id !== listing.id) {
        notes.push(`Your listing ${shortHex(listing.id)} is not for ${name} #${item.tokenId} on-chain, so it is NOT cancelled.`);
        continue;
      }
      const existingTotal = orderTotal(main.components);
      if (existingTotal >= item.unitPriceWei * item.quantity) continue;
      cancels.push(...verified);
      cancelLines.push([
        [`your listing of ${name} #${item.tokenId}`, native(existingTotal, chainId)],
        ...verified.slice(1).map((twin): [string, string] => ['and its linked OpenSea listing', native(orderTotal(twin.components), chainId)]),
      ]);
      aiNotes.push(`Cancels first: ${listing.id}${verified.length > 1 ? ` and its OpenSea twin ${verified.slice(1).map(twin => twin.id).join(', ')}` : ''}.`);
    }
  }

  const approvalsNeeded = contracts.filter((_, i) => !approvals[i]);
  const plan: ListingPlan = { kind: 'listing', chainId, wallet: offerer, counter, items, approvals: approvalsNeeded, cancels, orders, twins, twinRoyalties, sellWei: totalListed, belowFloorWei };

  card.rule();
  if (items.length > 1) card.row('Listed total', native(totalListed, chainId)).row('You receive in total', native(totalSeller, chainId));
  card.row('Expires', inDays(seconds, ctx.now()));
  for (const contract of approvalsNeeded) card.text(`One-time approval: let the OpenSea conduit move your ${nameOf(contract)} when it sells (1 transaction, you pay gas).`);
  if (approvalsNeeded.length === 0) card.text('No approval needed.');
  if (cancelLines.length > 0) {
    card.text(`First cancels ${cancelLines.length} cheaper listing${cancelLines.length === 1 ? '' : 's'} of yours on-chain, otherwise ${cancelLines.length === 1 ? 'it' : 'they'} would stay fillable:`);
    for (const [first, ...rest] of cancelLines) {
      card.row(`- ${first![0]}`, first![1], 2);
      for (const [label, price] of rest) card.row(label, price, 4);
    }
  }
  for (const note of notes) card.warn(note);
  card.text('Signing is free; the listing goes live once submitted.')
    .details([`Seaport ${shortHex(SEAPORT_ADDRESS)}`, `counter ${counter}`, `conduit ${shortHex(OPENSEA_CONDUIT_ADDRESS)}`]);
  const note = [
    `Listing ${items.length} item${items.length === 1 ? '' : 's'} from ${offerer}: ${items.map(item => `${item.contract} #${item.tokenId}`).join(', ')}.`,
    ...aiNotes,
    approvalsNeeded.length > 0 ? `Approvals: setApprovalForAll(OpenSea conduit ${OPENSEA_CONDUIT_ADDRESS}) on ${approvalsNeeded.join(', ')}.` : '',
    `Seaport ${SEAPORT_ADDRESS}, counter ${counter}.`,
  ].filter(Boolean);
  return { text: card.render(), plan, note };
}

export async function executeListing(ctx: Ctx, plan: ListingPlan, commit: () => void): Promise<string> {
  const { chainId } = plan;
  const offerer = me(ctx);
  if (plan.wallet !== offerer) throw new GuardError('This plan was made for another wallet.');
  const client = ctx.chains.client(chainId);
  const counter = await readSeaportCounter(client, offerer);
  if (counter !== plan.counter) throw new GuardError('Your Seaport counter changed since the preview. Run the preview again.');
  await Promise.all(plan.items.map(item => assertHolds(client, offerer, item)));
  plan.orders.forEach((order, i) => assertOwnListingOrder(order, { chainId, offerer, contract: plan.items[i]!.contract, tokenId: plan.items[i]!.tokenId, quantity: plan.items[i]!.quantity, unitPriceWei: plan.items[i]!.unitPriceWei }));
  plan.twins.forEach((twin, i) => {
    if (twin) assertOpenSeaTwin(twin, plan.orders[i]!, plan.twinRoyalties[i]!);
  });

  const stillNeeded: Address[] = [];
  for (const contract of plan.approvals) {
    if (!await readConduitApproval(client, contract, offerer)) stillNeeded.push(contract);
  }
  const nftContracts = new Set(plan.items.map(item => item.contract));
  const log: string[] = [];

  commit();
  const run = async (): Promise<string> => {
    for (const contract of stillNeeded) {
      const sent = await txStep(log, `Approve the OpenSea conduit on ${contract}`, () => sendGuardedTx(ctx.chains, ctx.account, { chainId, to: contract, data: setApprovalData(), value: 0n }, nftContracts));
      log.push(`Approved the OpenSea conduit on ${contract} (tx ${sent.hash}).`);
    }

    for (const chunk of chunkCancels(plan.cancels)) {
      const sent = await txStep(log, 'Cancel your cheaper listings', () => sendGuardedTx(ctx.chains, ctx.account, { chainId, to: SEAPORT_ADDRESS, data: encodeSeaportCancel(chunk.map(target => target.components)), value: 0n }, nftContracts));
      const cancelled = cancelledOrderHashes(sent.logs);
      const missed = chunk.filter(target => !target.twinOf && !cancelled.has(target.orderHash));
      if (missed.length > 0) {
        log.push(`Cancel transaction ${sent.hash} confirmed but did not cancel ${missed.map(target => target.id).join(', ')}.`);
        throw new Error(`The cancel transaction ${sent.hash} did not cancel ${missed.map(target => target.id).join(', ')}, so nothing new was listed.`);
      }
      log.push(`Cancelled ${chunk.filter(target => !target.twinOf).length} cheaper listing(s) (tx ${sent.hash}).`);
    }

    const twinOrders = plan.twins.filter((twin): twin is OrderComponents => twin !== null);
    let signed: SignedSeaportOrder[];
    const twinSigned = new Map<number, SignedSeaportOrder>();
    if (plan.orders.length === 1 && twinOrders.length === 0) {
      signed = [await signSeaportOrder(ctx.account, plan.orders[0]!, { chainId })];
    } else {
      const all = await signSeaportBulkOrders(ctx.account, [...plan.orders, ...twinOrders], { chainId });
      signed = all.slice(0, plan.orders.length);
      let next = plan.orders.length;
      plan.twins.forEach((twin, i) => {
        if (twin) twinSigned.set(i, all[next++]!);
      });
    }

    const payload = (entry: SignedSeaportOrder) => ({ parameters: serializeOrderComponents(entry.order), signature: entry.signature, orderHash: entry.orderHash });
    const twinPayload = (entry: SignedSeaportOrder | undefined) => (entry ? { parameters: serializeOrderComponents(entry.order), signature: entry.signature } : undefined);
    const withTwins = (indexes: number[]) => indexes.flatMap(i => [signed[i]!.order, ...(twinSigned.has(i) ? [twinSigned.get(i)!.order] : [])]);
    const rejected = (what: string, reason: string, indexes: number[]) => new RejectedOrderError([...log, rejectedOrdersText(chainId, what, reason, withTwins(indexes))].join('\n'));
    if (signed.length === 1) {
      let created;
      try {
        created = await ctx.api.createAsk(chainId, payload(signed[0]!), twinPayload(twinSigned.get(0)) ?? null);
      } catch (err) {
        throw rejected(`the signed listing oswiki-${signed[0]!.orderHash}`, err instanceof ApiError ? err.message : 'the request failed', [0]);
      }
      log.push(`Listed: ${created.askId ?? `oswiki-${signed[0]!.orderHash}`}.`);
      if (twinSigned.has(0)) log.push(created.crossListing ? `OpenSea cross-listing: ${created.crossListing.status}${created.crossListing.orderHash ? ` (${created.crossListing.orderHash})` : ''}.` : 'OpenSea cross-listing: sent.');
    } else {
      let result;
      try {
        result = await ctx.api.createAsksBulk(chainId, signed.map((entry, i) => {
          const twin = twinPayload(twinSigned.get(i));
          return twin ? { seaport: payload(entry), opensea: twin } : { seaport: payload(entry) };
        }));
      } catch (err) {
        throw rejected(`the ${signed.length} signed listings`, err instanceof ApiError ? err.message : 'the request failed', signed.map((_, i) => i));
      }
      log.push(`Listed ${result.created} of ${signed.length}${result.failed > 0 ? `, ${result.failed} rejected` : ''}.`);
      for (const failure of result.results.filter(entry => !entry.success)) {
        log.push(`- rejected ${failure.contractAddress ?? ''} #${failure.tokenId ?? '?'}: ${failure.message ?? failure.code ?? 'unknown reason'}`);
      }
      const missing = unacceptedIndexes(signed, result, 'askId');
      if (missing.length > 0) throw rejected(`${missing.length} of the signed listings`, 'see the rejections above', missing);
    }
    return log.join('\n');
  };
  try {
    return await run();
  } catch (err) {
    throw afterSends(log, err);
  }
}

function describeTwin(card: Card, aiNotes: string[], twin: OrderComponents, oswiki: OrderComponents, royalty: TwinRoyalty, chainId: number, markupBps: number, onchainRoyalty: boolean): void {
  const summary = assertOpenSeaTwin(twin, oswiki, royalty);
  const quantity = oswiki.offer[0]!.startAmount;
  const asked = applyOpenSeaMarkup(orderTotal(oswiki) / quantity, markupBps) * quantity;
  card.row('Also on OpenSea at', native(summary.total, chainId), 2);
  for (const fee of summary.fees) {
    card.row(fee.kind === 'opensea' ? `OpenSea fee ${percentLabel(fee.amount, summary.total)}` : `Creator fee ${percentLabel(fee.amount, summary.total)} → ${shortHex(fee.recipient)}`, `−${native(fee.amount, chainId)}`, 4);
    if (fee.kind === 'creator' && !onchainRoyalty) card.warn(`Creator fee ${UNVERIFIED_ROYALTY_LABEL}.`, 4);
  }
  card.row('You receive there', native(summary.seller, chainId), 4);
  if (summary.total > asked) card.text(`(raised from ${native(asked, chainId)} so the OpenSea payout is not below the OSWiki one)`, 4);
  if (twin.zone !== ZERO_ADDRESS) card.text(`OpenSea signed zone ${shortHex(twin.zone)}`, 4);
  aiNotes.push(`OpenSea twin: ${twin.zone === ZERO_ADDRESS ? 'open zone' : `OpenSea signed zone ${twin.zone}`}; fees ${summary.fees.map(fee => `${fee.kind} ${native(fee.amount, chainId)} to ${fee.recipient}`).join(', ') || 'none'}.`);
}
