import { decodeFunctionResult, type Address, type Hex } from 'viem';

import { encodeFulfillAdvancedOrder, encodeFulfillAvailableAdvancedOrders, FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, type SeaportAdvancedOrder } from '../abi.js';
import { networkFee, sendGuardedTx } from '../chain.js';
import { NATIVE_SYMBOL, SEAPORT_ADDRESS, type SupportedChainId } from '../constants.js';
import { ApiError } from '../api.js';
import { native } from '../format.js';
import { Card, feeValue, feeWarnings, shortHex, type CardPreview } from '../format-card.js';
import { assertOswikiSeaportOrder, filledOrders, orderHashFromAskId, OswikiOrderGuardError, revertMessage, type FilledOrder } from '../seaport/fulfill.js';
import { readSeaportCounter } from '../seaport/listing.js';
import { assertOpenSeaSeaportOrder } from '../seaport/opensea-buy.js';
import { hashOrderComponents } from '../seaport/sign.js';
import { checkBuyCollection, PRICE_OVER_FLOOR_FACTOR, type CollectionCheck } from './collection-check.js';
import { assertBuyingEnabled, assertCollectionAllowed, assertMaxBuy, chainOf, GuardError, me, type Ctx } from './common.js';
import { txStep } from './tx-steps.js';

export const MAX_BUY_ITEMS = 20;
export const BUY_ASK_ID_RE = /^(?:oswiki-)?0x[0-9a-fA-F]{64}$/;

export type BuyMarketplace = 'oswiki' | 'opensea';

const MARKETPLACE_NAME: Record<BuyMarketplace, string> = { oswiki: 'OSWiki', opensea: 'OpenSea' };

export interface BuyEntry {
  askId: string;
  marketplace: BuyMarketplace;
  orderHash: Hex;
  contract: Address;
  tokenId: string;
  quantity: bigint;
  value: bigint;
}

export interface BuyPlan {
  kind: 'buy';
  chainId: SupportedChainId;
  wallet: Address;
  entries: BuyEntry[];
  totalValue: bigint;
}

export interface LoadedOrder extends BuyEntry {
  order: SeaportAdvancedOrder;
}

function marketplaceOf(askId: string): BuyMarketplace {
  return askId.startsWith('oswiki-') ? 'oswiki' : 'opensea';
}

async function fetchBuyData(ctx: Ctx, chainId: SupportedChainId, askId: string, maxPriceWei?: bigint): Promise<[Record<string, unknown>, Awaited<ReturnType<Ctx['api']['listing']>>]> {
  try {
    const [data, meta] = await Promise.all([ctx.api.buyData(chainId, askId, me(ctx), maxPriceWei), ctx.api.listing(chainId, askId)]);
    return [(data ?? {}) as Record<string, unknown>, meta];
  } catch (err) {
    if (err instanceof ApiError && err.code) throw new GuardError(`${askId} cannot be bought: ${err.message}. Nothing was sent.`);
    throw err;
  }
}

/** Fresh buy data per ask, guarded, and its struct hash under the seller's live counter must equal the askId. */
export async function loadOrder(ctx: Ctx, chainId: SupportedChainId, askId: string, maxPriceWei?: bigint): Promise<LoadedOrder> {
  const marketplace = marketplaceOf(askId);
  const [data, meta] = await fetchBuyData(ctx, chainId, askId, maxPriceWei);
  let guarded: { order: SeaportAdvancedOrder; value: bigint };
  if (marketplace === 'opensea') {
    if (!meta.contract || !meta.tokenId || meta.contract === 'invalid' || meta.tokenId === 'invalid') throw new GuardError(`The OSWiki API did not say which NFT ${askId} sells. Nothing was sent.`);
    guarded = assertOpenSeaSeaportOrder(data, { contract: meta.contract, tokenId: meta.tokenId, wallet: me(ctx), nowSeconds: BigInt(Math.floor(ctx.now() / 1000)) });
  } else {
    if (data.marketplace !== undefined && data.marketplace !== 'oswiki') throw new OswikiOrderGuardError('not served as an OSWiki listing');
    guarded = assertOswikiSeaportOrder(data, { contract: meta.contract || null, tokenId: meta.tokenId || null });
    if (typeof data.data === 'string' && data.data.toLowerCase() !== encodeFulfillAdvancedOrder(guarded.order, me(ctx))) throw new OswikiOrderGuardError('the server calldata does not match the order');
  }
  const params = guarded.order.parameters;
  const offerer = params.offerer;
  if (offerer === me(ctx)) throw new GuardError(`${askId} is this wallet's own listing.`);
  const counter = await readSeaportCounter(ctx.chains.client(chainId), offerer);
  const { totalOriginalConsiderationItems: _total, ...components } = params;
  const orderHash = hashOrderComponents({ ...components, counter });
  if (orderHashFromAskId(askId) !== orderHash) throw new GuardError(`The order data for ${askId} does not hash to that listing (or the seller cancelled all orders). Nothing was sent.`);
  const item = params.offer[0]!;
  return {
    askId,
    marketplace,
    orderHash,
    contract: item.token,
    tokenId: item.identifierOrCriteria.toString(),
    quantity: (item.startAmount * guarded.order.numerator) / guarded.order.denominator,
    value: guarded.value,
    order: guarded.order,
  };
}

function encodeBuy(orders: SeaportAdvancedOrder[], recipient: Address): Hex {
  return orders.length === 1 ? encodeFulfillAdvancedOrder(orders[0]!, recipient) : encodeFulfillAvailableAdvancedOrders(orders, recipient);
}

/** Every order must be fillable in the simulation; a partly fillable sweep is refused rather than sent. */
async function simulateBuy(ctx: Ctx, chainId: SupportedChainId, loaded: LoadedOrder[], total: bigint): Promise<void> {
  const client = ctx.chains.client(chainId);
  const data = encodeBuy(loaded.map(entry => entry.order), me(ctx));
  let result;
  try {
    result = await client.call({ account: ctx.account.address, to: SEAPORT_ADDRESS, data, value: total });
  } catch (err) {
    throw new GuardError(`The purchase would fail: ${revertMessage(err)}. Nothing was sent.`);
  }
  if (loaded.length > 1) {
    const [available] = decodeFunctionResult({ abi: FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, functionName: 'fulfillAvailableAdvancedOrders', data: (result.data ?? '0x') as Hex });
    const missing = loaded.filter((_, i) => available[i] !== true);
    if (missing.length > 0) throw new GuardError(`No longer available: ${missing.map(entry => entry.askId).join(', ')}. Preview again without them.`);
  }
}

export async function previewBuy(ctx: Ctx, input: { chainId: number; askIds: string[] }): Promise<CardPreview<BuyPlan>> {
  const chainId = chainOf(input.chainId);
  assertBuyingEnabled(ctx.config, chainId);
  const raw = input.askIds ?? [];
  const bad = raw.filter(id => typeof id !== 'string' || !BUY_ASK_ID_RE.test(id));
  if (bad.length > 0) throw new GuardError(`Only OSWiki listings (askId "oswiki-0x...") and OpenSea listings (askId "0x" + 64 hex) can be bought here: ${bad.map(String).join(', ').slice(0, 200)}.`);
  const askIds = [...new Set(raw.map(id => id.toLowerCase()))];
  if (askIds.length === 0 || askIds.length > MAX_BUY_ITEMS) throw new GuardError(`Buy 1 to ${MAX_BUY_ITEMS} listings at once.`);
  const hashes = askIds.map(orderHashFromAskId);
  if (new Set(hashes).size !== hashes.length) throw new GuardError('The same order is listed twice. Nothing was sent.');

  const loaded = await Promise.all(askIds.map(askId => loadOrder(ctx, chainId, askId)));
  for (const entry of loaded) assertCollectionAllowed(ctx.config, entry.contract);
  const total = loaded.reduce((sum, entry) => sum + entry.value, 0n);
  assertMaxBuy(ctx.config, chainId, total, 'This purchase');

  const client = ctx.chains.client(chainId);
  const contracts = [...new Set(loaded.map(entry => entry.contract))];
  const [balance, checks] = await Promise.all([
    client.getBalance({ address: ctx.account.address }),
    ctx.api.verifiedCollections(chainId).catch(() => null).then(verified => Promise.all(contracts.map(contract => checkBuyCollection(ctx, chainId, contract, verified)))),
  ]);
  const checkOf = new Map<string, CollectionCheck>(contracts.map((contract, i) => [contract, checks[i]!]));
  if (balance < total) throw new GuardError(`Not enough ${NATIVE_SYMBOL[chainId]}: the purchase costs ${native(total, chainId)}, the wallet has ${native(balance, chainId)}.`);
  await simulateBuy(ctx, chainId, loaded, total);

  const data = encodeBuy(loaded.map(entry => entry.order), me(ctx));
  const estimate = await client.estimateGas({ account: ctx.account.address, to: SEAPORT_ADDRESS, data, value: total }).catch(() => undefined);
  const fee = await networkFee(ctx.chains, chainId, [{ shape: { kind: 'buy', orders: loaded.length }, estimate }]);

  const plan: BuyPlan = {
    kind: 'buy',
    chainId,
    wallet: me(ctx),
    entries: loaded.map(({ order: _order, ...entry }) => entry),
    totalValue: total,
  };
  const markets = (['oswiki', 'opensea'] as const).filter(market => loaded.some(entry => entry.marketplace === market)).map(market => MARKETPLACE_NAME[market]).join(' + ');
  const card = new Card(loaded.length === 1 ? 'purchase' : `purchase of ${loaded.length} items`, chainId, { irreversible: true });
  const shown = new Set<string>();
  for (const entry of loaded) {
    const check = checkOf.get(entry.contract)!;
    const label = check.name === entry.contract ? shortHex(entry.contract) : check.name;
    card.row(`${label} #${entry.tokenId}${entry.quantity > 1n ? ` ×${entry.quantity}` : ''}`, native(entry.value, chainId));
    card.text(`${MARKETPLACE_NAME[entry.marketplace]} · ${check.badge} · floor ${check.floorWei === null ? 'none' : native(check.floorWei, chainId)}`, 2);
    const unitWei = entry.value / (entry.quantity > 0n ? entry.quantity : 1n);
    if (check.floorWei !== null && unitWei > check.floorWei * PRICE_OVER_FLOOR_FACTOR) card.warn(`This costs more than ${PRICE_OVER_FLOOR_FACTOR}x the collection floor (${native(check.floorWei, chainId)}).`, 2);
    if (!shown.has(entry.contract)) {
      shown.add(entry.contract);
      for (const warning of check.warnings) card.warn(warning, 2);
    }
  }
  const after = balance - total - (fee.nowWei ?? fee.maxWei);
  card.rule()
    .row('Total', native(total, chainId))
    .row('Network fee', feeValue(fee, chainId))
    .row('Wallet after', `~${native(after > 0n ? after : 0n, chainId)}`);
  for (const warning of feeWarnings(fee)) card.warn(warning);
  card.text('✓ Simulated just now: it goes through.')
    .details([`Seaport ${shortHex(SEAPORT_ADDRESS)}`, loaded.length === 1 ? `order ${shortHex(loaded[0]!.orderHash)}` : `${loaded.length} orders`]);
  const note = [
    `Buying ${loaded.length} ${markets} listing${loaded.length === 1 ? '' : 's'} for ${me(ctx)} (wallet balance ${native(balance, chainId)}). ${fee.text}`,
    ...loaded.map(entry => `- ${entry.askId}: ${checkOf.get(entry.contract)!.name} ${entry.contract} #${entry.tokenId}${entry.quantity > 1n ? ` x${entry.quantity}` : ''} for ${native(entry.value, chainId)} on ${MARKETPLACE_NAME[entry.marketplace]}`),
    `One transaction to Seaport ${SEAPORT_ADDRESS}.`,
  ];
  return { text: card.render(), plan, note };
}

function fillLine(entry: LoadedOrder, fill: FilledOrder | undefined, chainId: SupportedChainId): string {
  if (!fill || fill.received === 0n) return `NOT filled (${native(entry.value, chainId)} refunded by Seaport)`;
  if (fill.received >= entry.quantity) return entry.quantity > 1n ? `bought ${fill.received}` : 'bought';
  const missing = entry.quantity - fill.received;
  const refunded = entry.value > fill.paid ? entry.value - fill.paid : 0n;
  return `bought ${fill.received} of ${entry.quantity} (${missing} ${missing === 1n ? 'was' : 'were'} sold to someone else first; the difference of ${native(refunded, chainId)} was refunded)`;
}

export async function executeBuy(ctx: Ctx, plan: BuyPlan, commit: () => void): Promise<string> {
  const { chainId } = plan;
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  const loaded = await Promise.all(plan.entries.map(entry => loadOrder(ctx, chainId, entry.askId, entry.value)));
  loaded.forEach((entry, i) => {
    const planned = plan.entries[i]!;
    if (entry.orderHash !== planned.orderHash || entry.value !== planned.value || entry.contract !== planned.contract || entry.tokenId !== planned.tokenId || entry.quantity !== planned.quantity || entry.marketplace !== planned.marketplace) {
      throw new GuardError(`${entry.askId} changed since the preview. Run the preview again.`);
    }
    assertCollectionAllowed(ctx.config, entry.contract);
  });
  const total = loaded.reduce((sum, entry) => sum + entry.value, 0n);
  if (total !== plan.totalValue) throw new GuardError('The total changed since the preview. Run the preview again.');
  assertMaxBuy(ctx.config, chainId, total, 'This purchase');
  await simulateBuy(ctx, chainId, loaded, total);

  commit();
  const sent = await txStep([], `Buy for ${native(total, chainId)}`, () => sendGuardedTx(ctx.chains, ctx.account, { chainId, to: SEAPORT_ADDRESS, data: encodeBuy(loaded.map(entry => entry.order), me(ctx)), value: total }, new Set()));
  const filled = filledOrders(sent.logs, new Map(loaded.map(entry => [entry.orderHash, { token: entry.contract, identifier: BigInt(entry.tokenId) }])));
  const lines = [`Transaction ${sent.hash} confirmed.`];
  for (const entry of loaded) lines.push(`- ${entry.askId}: ${fillLine(entry, filled.get(entry.orderHash), chainId)}`);
  return lines.join('\n');
}
