import type { Address } from 'viem';

import { ApiError } from '../api.js';
import { sendGuardedTx } from '../chain.js';
import { getOswikiFeeRecipient, OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, ZERO_ADDRESS, type SupportedChainId } from '../constants.js';
import { addressLabel, CONFIRM_FOOTER, native, parsePositiveAmount } from '../format.js';
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
import { applyMinFloor, checkListingPrice, fetchCollectionReferences, type CollectionReferences } from './references.js';

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

export async function previewListing(ctx: Ctx, input: ListingInput): Promise<{ text: string; plan: ListingPlan }> {
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
  const lines: string[] = [];
  const orders: OrderComponents[] = [];
  const twins: Array<OrderComponents | null> = [];
  const twinRoyalties: TwinRoyalty[] = [];
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

    let twin: OrderComponents | null = null;
    let twinLines: string[] = [];
    if (input.crossListOpenSea) {
      const terms = usableOpenSeaTerms(requirement.opensea ?? null, chainId);
      let reason = 'OpenSea\'s terms for this collection are missing or failed the safety check (Seaport, conduit, OpenSea fee recipient, fee at most 1%, known zone)';
      if (terms) {
        try {
          assertTwinCreatorFees(terms, twinRoyalty, offerer);
          twin = buildOpenSeaOrder(order, terms, undefined, markupBps);
          twinLines = describeTwin(twin, order, twinRoyalty, chainId, markupBps, royaltySourceLabel(royalty.source));
        } catch (err) {
          twin = null;
          reason = err instanceof OpenSeaTwinError ? err.message : 'the OpenSea order could not be priced';
        }
      }
      if (!twin) notes.push(`#${item.tokenId}: NOT cross-listed on OpenSea (${reason}). It is listed on OSWiki only.`);
    }
    twins.push(twin);
    twinRoyalties.push(twinRoyalty);

    const check = checkListingPrice(refs, { chainId, contract: item.contract, tokenId: item.tokenId, unitPriceWei: item.unitPriceWei, nowMs: ctx.now() });
    const name = refs.info?.name ? `${refs.info.name} ` : '';
    lines.push(`- ${name}${item.contract} #${item.tokenId}${item.isErc1155 ? ` x${item.quantity}` : ''}: ${native(totalWei, chainId)}`
      + ` | fee ${native(amounts.fee, chainId)} | royalty ${native(amounts.royalty, chainId)} | you receive ${native(amounts.seller, chainId)}`);
    lines.push(royalty.recipient
      ? `  royalty ${native(royalty.wei, chainId)} to ${addressLabel(royalty.recipient)}, ${royaltySourceLabel(royalty.source)}`
      : '  no royalty');
    lines.push(...twinLines);
    lines.push(`  references: ${check.references}`);
    for (const warning of check.warnings) lines.push(`  ${warning}`);
    if (floorNote) lines.push(`  NOTE: ${floorNote}`);
  }

  const cancels: SeaportCancelTarget[] = [];
  const cancelLines: string[] = [];
  if (myListings === null && items.some(item => !item.isErc1155)) {
    notes.push('Could not load your existing listings: a cheaper older listing of the same token would stay fillable. Check with my_listings.');
  }
  for (const item of items.filter(entry => !entry.isErc1155)) {
    const mine = (myListings ?? []).filter(listing => listing.contract === item.contract && listing.tokenId === item.tokenId);
    const name = refsBy.get(item.contract)?.info?.name || item.contract;
    for (const listing of mine) {
      let targets: SeaportCancelTarget[];
      try {
        const stored = await ctx.api.askComponents(chainId, listing.id);
        targets = prepareListingCancels(listing.id, stored.components, stored.twin, offerer);
      } catch {
        notes.push(`Could not verify your existing listing ${listing.id} of #${item.tokenId}, so it is NOT cancelled; if it is cheaper it stays fillable. Check with my_listings.`);
        continue;
      }
      const verified = targets.filter(target => sameListedItem(target.components, item.contract, item.tokenId));
      const main = verified[0];
      if (!main || main.id !== listing.id) {
        notes.push(`Your listing ${listing.id} is not for ${item.contract} #${item.tokenId} on-chain, so it is NOT cancelled.`);
        continue;
      }
      const existingTotal = orderTotal(main.components);
      if (existingTotal >= item.unitPriceWei * item.quantity) continue;
      cancels.push(...verified);
      cancelLines.push(`- cancel your listing of ${name} #${item.tokenId} at ${native(existingTotal, chainId)} (${listing.id})`);
      for (const twin of verified.slice(1)) cancelLines.push(`  and its linked OpenSea listing of ${name} #${item.tokenId} at ${native(orderTotal(twin.components), chainId)}`);
    }
  }

  const approvalsNeeded = contracts.filter((_, i) => !approvals[i]);
  const plan: ListingPlan = { kind: 'listing', chainId, wallet: offerer, counter, items, approvals: approvalsNeeded, cancels, orders, twins, twinRoyalties };

  const text = [
    `PREVIEW: list ${items.length} item${items.length === 1 ? '' : 's'} on ${chainId === 1 ? 'Ethereum' : 'ApeChain'} from ${offerer}, valid ${Math.round(seconds / 86400 * 10) / 10} days.`,
    ...lines,
    approvalsNeeded.length > 0 ? `Approvals (one transaction each, gas paid by you): setApprovalForAll(OpenSea conduit ${'0x1e0049783f008a0085193e00003d00cd54003c71'}) on ${approvalsNeeded.join(', ')}.` : 'No approval needed.',
    cancels.length > 0 ? `First cancels ${cancels.filter(c => !c.twinOf).length} cheaper existing listing(s) of yours on-chain, otherwise they would stay fillable:` : '',
    ...cancelLines,
    ...notes.map(note => `NOTE: ${note}`),
    `Seaport ${SEAPORT_ADDRESS}, counter ${counter}. Signing is free; the listing goes live once submitted.`,
  ].filter(Boolean);
  return { text: text.join('\n'), plan };
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
  for (const contract of stillNeeded) {
    const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId, to: contract, data: setApprovalData(), value: 0n }, nftContracts);
    log.push(`Approved the OpenSea conduit on ${contract} (tx ${sent.hash}).`);
  }

  for (const chunk of chunkCancels(plan.cancels)) {
    const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId, to: SEAPORT_ADDRESS, data: encodeSeaportCancel(chunk.map(target => target.components)), value: 0n }, nftContracts);
    const cancelled = cancelledOrderHashes(sent.logs);
    const missed = chunk.filter(target => !target.twinOf && !cancelled.has(target.orderHash));
    if (missed.length > 0) throw new Error(`The cancel transaction ${sent.hash} did not cancel ${missed.map(target => target.id).join(', ')}, so nothing new was listed.`);
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
}

function describeTwin(twin: OrderComponents, oswiki: OrderComponents, royalty: TwinRoyalty, chainId: number, markupBps: number, royaltyLabel: string): string[] {
  const summary = assertOpenSeaTwin(twin, oswiki, royalty);
  const quantity = oswiki.offer[0]!.startAmount;
  const asked = applyOpenSeaMarkup(orderTotal(oswiki) / quantity, markupBps) * quantity;
  const zone = twin.zone === ZERO_ADDRESS ? 'open zone' : `OpenSea signed zone ${twin.zone}`;
  return [
    `  OpenSea: listed at ${native(summary.total, chainId)} (${zone}), you receive ${native(summary.seller, chainId)} there`
      + (summary.total > asked ? ` (raised from ${native(asked, chainId)} so the OpenSea payout is not below the OSWiki one)` : ''),
    ...summary.fees.map(fee => `    ${fee.kind === 'opensea' ? 'OpenSea fee' : 'creator fee'} ${native(fee.amount, chainId)} to ${addressLabel(fee.recipient)}${fee.kind === 'creator' ? `, ${royaltyLabel}` : ''}`),
  ];
}

export { CONFIRM_FOOTER };
