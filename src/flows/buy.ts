import { decodeFunctionResult, type Address, type Hex } from 'viem';

import { encodeFulfillAdvancedOrder, encodeFulfillAvailableAdvancedOrders, FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, type SeaportAdvancedOrder } from '../abi.js';
import { networkFee, sendGuardedTx } from '../chain.js';
import { NATIVE_SYMBOL, SEAPORT_ADDRESS, type SupportedChainId } from '../constants.js';
import { native } from '../format.js';
import { assertOswikiSeaportOrder, fulfilledOrderHashes, orderHashFromAskId, revertMessage } from '../seaport/fulfill.js';
import { readSeaportCounter } from '../seaport/listing.js';
import { hashOrderComponents } from '../seaport/sign.js';
import { checkBuyCollection, PRICE_OVER_FLOOR_FACTOR, type CollectionCheck } from './collection-check.js';
import { assertBuyingEnabled, assertCollectionAllowed, assertMaxBuy, chainOf, GuardError, me, ORDER_ID_RE, type Ctx } from './common.js';

export const MAX_BUY_ITEMS = 20;

export interface BuyEntry {
  askId: string;
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

interface LoadedOrder extends BuyEntry {
  order: SeaportAdvancedOrder;
}

/** Fresh buy data per ask, guarded, and its struct hash under the seller's live counter must equal the askId. */
async function loadOrder(ctx: Ctx, chainId: SupportedChainId, askId: string): Promise<LoadedOrder> {
  const [data, meta] = await Promise.all([ctx.api.buyData(chainId, askId), ctx.api.listing(chainId, askId)]);
  const guarded = assertOswikiSeaportOrder((data ?? {}) as Record<string, unknown>, { contract: meta.contract || null, tokenId: meta.tokenId || null });
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

export async function previewBuy(ctx: Ctx, input: { chainId: number; askIds: string[] }): Promise<{ text: string; plan: BuyPlan }> {
  const chainId = chainOf(input.chainId);
  assertBuyingEnabled(ctx.config, chainId);
  const askIds = [...new Set(input.askIds ?? [])];
  if (askIds.length === 0 || askIds.length > MAX_BUY_ITEMS) throw new GuardError(`Buy 1 to ${MAX_BUY_ITEMS} listings at once.`);
  const bad = askIds.filter(id => !ORDER_ID_RE.test(id));
  if (bad.length > 0) throw new GuardError(`Only OSWiki listings (askId "oswiki-0x...") can be bought here: ${bad.join(', ').slice(0, 200)}.`);

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
  const text = [
    `PREVIEW: buy ${loaded.length} OSWiki listing${loaded.length === 1 ? '' : 's'} on ${chainId === 1 ? 'Ethereum' : 'ApeChain'} for ${me(ctx)}.`,
    ...loaded.flatMap((entry) => {
      const check = checkOf.get(entry.contract)!;
      const line = `- ${entry.askId}: ${check.name} ${entry.contract} #${entry.tokenId}${entry.quantity > 1n ? ` x${entry.quantity}` : ''} for ${native(entry.value, chainId)}`;
      const unitWei = entry.value / (entry.quantity > 0n ? entry.quantity : 1n);
      return check.floorWei !== null && unitWei > check.floorWei * PRICE_OVER_FLOOR_FACTOR
        ? [line, `  WARNING: this costs more than ${PRICE_OVER_FLOOR_FACTOR}x the collection floor (${native(check.floorWei, chainId)}). Double-check it with the user.`]
        : [line];
    }),
    ...checks.flatMap(check => check.lines),
    `Total: ${native(total, chainId)} (wallet balance ${native(balance, chainId)}).`,
    fee.text,
    `One transaction to Seaport ${SEAPORT_ADDRESS}; the simulation passed just now.`,
  ];
  return { text: text.join('\n'), plan };
}

export async function executeBuy(ctx: Ctx, plan: BuyPlan, commit: () => void): Promise<string> {
  const { chainId } = plan;
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  const loaded = await Promise.all(plan.entries.map(entry => loadOrder(ctx, chainId, entry.askId)));
  loaded.forEach((entry, i) => {
    const planned = plan.entries[i]!;
    if (entry.orderHash !== planned.orderHash || entry.value !== planned.value || entry.contract !== planned.contract || entry.tokenId !== planned.tokenId) {
      throw new GuardError(`${entry.askId} changed since the preview. Run the preview again.`);
    }
    assertCollectionAllowed(ctx.config, entry.contract);
  });
  const total = loaded.reduce((sum, entry) => sum + entry.value, 0n);
  if (total !== plan.totalValue) throw new GuardError('The total changed since the preview. Run the preview again.');
  assertMaxBuy(ctx.config, chainId, total, 'This purchase');
  await simulateBuy(ctx, chainId, loaded, total);

  commit();
  const sent = await sendGuardedTx(ctx.chains, ctx.account, { chainId, to: SEAPORT_ADDRESS, data: encodeBuy(loaded.map(entry => entry.order), me(ctx)), value: total }, new Set());
  const filled = fulfilledOrderHashes(sent.logs);
  const lines = [`Transaction ${sent.hash} confirmed.`];
  for (const entry of loaded) lines.push(`- ${entry.askId}: ${filled.has(entry.orderHash) ? 'bought' : 'NOT filled (refunded by Seaport)'}`);
  return lines.join('\n');
}
