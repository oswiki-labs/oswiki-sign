import { decodeFunctionResult, encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';

import { encodeFulfillAdvancedOrder, encodeFulfillAvailableAdvancedOrders, FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI, WRAPPED_NATIVE_ABI, type SeaportAdvancedOrder } from '../abi.js';
import { networkFee, sendGuardedTx, type TxShape } from '../chain.js';
import { GONDI_FEE_BPS, NATIVE_SYMBOL, SEAPORT_ADDRESS, WRAPPED_NATIVE, WRAPPED_SYMBOL, type SupportedChainId } from '../constants.js';
import { ApiError } from '../api.js';
import { native, wrapped } from '../format.js';
import { bpsLabel, Card, feeValue, feeWarnings, shortHex, type CardPreview } from '../format-card.js';
import { assertOswikiSeaportOrder, filledOrders, orderHashFromAskId, OswikiOrderGuardError, revertMessage, type FilledOrder } from '../seaport/fulfill.js';
import { assertGondiSeaportOrder } from '../seaport/gondi-buy.js';
import { readSeaportCounter } from '../seaport/listing.js';
import { assertOpenSeaSeaportOrder } from '../seaport/opensea-buy.js';
import { hashOrderComponents } from '../seaport/sign.js';
import { checkBuyCollection, PRICE_OVER_FLOOR_FACTOR, type CollectionCheck } from './collection-check.js';
import { assertBuyingEnabled, assertCollectionAllowed, assertMaxBuy, chainOf, GuardError, me, type Ctx } from './common.js';
import { boundedAllowance, ownOpenOffersWei } from './offer.js';
import { afterSends, txStep } from './tx-steps.js';

export const MAX_BUY_ITEMS = 20;
export const BUY_ASK_ID_RE = /^(?:(?:oswiki|gondi)-)?0x[0-9a-fA-F]{64}$/;

export type BuyMarketplace = 'oswiki' | 'opensea' | 'gondi';
export type BuyCurrency = 'native' | 'wrapped';

const MARKETPLACES: readonly BuyMarketplace[] = ['oswiki', 'opensea', 'gondi'];
export const MARKETPLACE_NAME: Record<BuyMarketplace, string> = { oswiki: 'OSWiki', opensea: 'OpenSea', gondi: 'Gondi' };

export interface BuyEntry {
  askId: string;
  marketplace: BuyMarketplace;
  orderHash: Hex;
  contract: Address;
  tokenId: string;
  quantity: bigint;
  /** The full price, in `currency`. */
  value: bigint;
  currency: BuyCurrency;
}

export interface BuyPlan {
  kind: 'buy';
  chainId: SupportedChainId;
  wallet: Address;
  entries: BuyEntry[];
  /** Everything the purchase spends, native + wrapped: what the limits count. */
  totalValue: bigint;
  nativeValue: bigint;
  wrappedValue: bigint;
  /** Set when the preview found the wrapped-native allowance to Seaport too low. */
  requiredAllowanceWei: bigint | null;
}

export interface LoadedOrder extends BuyEntry {
  order: SeaportAdvancedOrder;
  fees: { sellerWei: bigint; gondiFeeWei: bigint; otherFeesWei: bigint } | null;
}

/** Bare 0x hashes are OpenSea; any other prefix than oswiki- / gondi- is refused, never guessed. */
export function marketplaceOf(askId: string): BuyMarketplace {
  const prefix = /^([^-]+)-/.exec(askId)?.[1];
  if (prefix === undefined) return 'opensea';
  if (prefix === 'oswiki' || prefix === 'gondi') return prefix;
  throw new GuardError(`${askId} is from a marketplace oswiki-sign cannot buy from. Nothing was sent.`);
}

function amountLabel(wei: bigint, currency: BuyCurrency, chainId: SupportedChainId): string {
  return currency === 'wrapped' ? wrapped(wei, chainId) : native(wei, chainId);
}

function totals(entries: BuyEntry[]): { nativeWei: bigint; wrappedWei: bigint; total: bigint } {
  const nativeWei = entries.filter(entry => entry.currency === 'native').reduce((sum, entry) => sum + entry.value, 0n);
  const wrappedWei = entries.filter(entry => entry.currency === 'wrapped').reduce((sum, entry) => sum + entry.value, 0n);
  return { nativeWei, wrappedWei, total: nativeWei + wrappedWei };
}

function totalLabel(nativeWei: bigint, wrappedWei: bigint, chainId: SupportedChainId): string {
  if (wrappedWei === 0n) return native(nativeWei, chainId);
  if (nativeWei === 0n) return wrapped(wrappedWei, chainId);
  return `${native(nativeWei, chainId)} + ${wrapped(wrappedWei, chainId)}`;
}

async function readWrappedFunding(client: PublicClient, chainId: SupportedChainId, wallet: Address): Promise<{ balance: bigint; allowance: bigint }> {
  const token = WRAPPED_NATIVE[chainId]!;
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: token, abi: WRAPPED_NATIVE_ABI, functionName: 'balanceOf', args: [wallet] }),
    client.readContract({ address: token, abi: WRAPPED_NATIVE_ABI, functionName: 'allowance', args: [wallet, SEAPORT_ADDRESS] }),
  ]);
  return { balance, allowance };
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
  const nowSeconds = BigInt(Math.floor(ctx.now() / 1000));
  const nft = () => {
    if (!meta.contract || !meta.tokenId || meta.contract === 'invalid' || meta.tokenId === 'invalid') throw new GuardError(`The OSWiki API did not say which NFT ${askId} sells. Nothing was sent.`);
    return { contract: meta.contract, tokenId: meta.tokenId, wallet: me(ctx), nowSeconds };
  };
  let guarded: { order: SeaportAdvancedOrder; value: bigint; currency: BuyCurrency; fees: LoadedOrder['fees'] };
  if (marketplace === 'opensea') {
    guarded = { ...assertOpenSeaSeaportOrder(data, nft()), currency: 'native', fees: null };
  } else if (marketplace === 'gondi') {
    const gondi = assertGondiSeaportOrder(data, { ...nft(), chainId });
    guarded = { order: gondi.order, value: gondi.costWei, currency: gondi.currency, fees: { sellerWei: gondi.sellerWei, gondiFeeWei: gondi.gondiFeeWei, otherFeesWei: gondi.otherFeesWei } };
  } else {
    if (data.marketplace !== undefined && data.marketplace !== 'oswiki') throw new OswikiOrderGuardError('not served as an OSWiki listing');
    guarded = { ...assertOswikiSeaportOrder(data, { contract: meta.contract || null, tokenId: meta.tokenId || null }), currency: 'native', fees: null };
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
    currency: guarded.currency,
    order: guarded.order,
    fees: guarded.fees,
  };
}

function encodeBuy(orders: SeaportAdvancedOrder[], recipient: Address): Hex {
  return orders.length === 1 ? encodeFulfillAdvancedOrder(orders[0]!, recipient) : encodeFulfillAvailableAdvancedOrders(orders, recipient);
}

/** Every order must be fillable in the simulation; a partly fillable sweep is refused rather than sent. */
async function simulateBuy(ctx: Ctx, chainId: SupportedChainId, loaded: LoadedOrder[], nativeWei: bigint): Promise<void> {
  const client = ctx.chains.client(chainId);
  const data = encodeBuy(loaded.map(entry => entry.order), me(ctx));
  let result;
  try {
    result = await client.call({ account: ctx.account.address, to: SEAPORT_ADDRESS, data, value: nativeWei });
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
  if (bad.length > 0) throw new GuardError(`Only OSWiki listings (askId "oswiki-0x..."), Gondi listings ("gondi-0x...") and OpenSea listings (askId "0x" + 64 hex) can be bought here: ${bad.map(String).join(', ').slice(0, 200)}.`);
  const askIds = [...new Set(raw.map(id => id.toLowerCase()))];
  if (askIds.length === 0 || askIds.length > MAX_BUY_ITEMS) throw new GuardError(`Buy 1 to ${MAX_BUY_ITEMS} listings at once.`);
  const hashes = askIds.map(orderHashFromAskId);
  if (new Set(hashes).size !== hashes.length) throw new GuardError('The same order is listed twice. Nothing was sent.');

  const loaded = await Promise.all(askIds.map(askId => loadOrder(ctx, chainId, askId)));
  for (const entry of loaded) assertCollectionAllowed(ctx.config, entry.contract);
  const { nativeWei, wrappedWei, total } = totals(loaded);
  assertMaxBuy(ctx.config, chainId, total, 'This purchase');

  const wallet = me(ctx);
  const client = ctx.chains.client(chainId);
  const contracts = [...new Set(loaded.map(entry => entry.contract))];
  const [balance, funding, openOffers, checks] = await Promise.all([
    client.getBalance({ address: ctx.account.address }),
    wrappedWei > 0n ? readWrappedFunding(client, chainId, wallet) : Promise.resolve(null),
    wrappedWei > 0n ? ownOpenOffersWei(ctx, chainId, wallet) : Promise.resolve(null),
    ctx.api.verifiedCollections(chainId).catch(() => null).then(verified => Promise.all(contracts.map(contract => checkBuyCollection(ctx, chainId, contract, verified)))),
  ]);
  const checkOf = new Map<string, CollectionCheck>(contracts.map((contract, i) => [contract, checks[i]!]));
  if (balance < nativeWei) throw new GuardError(`Not enough ${NATIVE_SYMBOL[chainId]}: the purchase costs ${native(nativeWei, chainId)}, the wallet has ${native(balance, chainId)}.`);
  let requiredAllowanceWei: bigint | null = null;
  if (funding) {
    if (funding.balance < wrappedWei) throw new GuardError(`Not enough ${WRAPPED_SYMBOL[chainId]}: the ${WRAPPED_SYMBOL[chainId]}-priced listings cost ${wrapped(wrappedWei, chainId)}, the wallet has ${wrapped(funding.balance, chainId)}. Nothing was sent.`);
    const required = boundedAllowance({ openOffersWei: openOffers, currentAllowance: funding.allowance, wrappedBalance: funding.balance - wrappedWei, totalWei: wrappedWei });
    if (funding.allowance < required) requiredAllowanceWei = required;
  }
  const approve = requiredAllowanceWei !== null;
  if (!approve) await simulateBuy(ctx, chainId, loaded, nativeWei);

  const data = encodeBuy(loaded.map(entry => entry.order), wallet);
  const estimate = approve ? undefined : await client.estimateGas({ account: ctx.account.address, to: SEAPORT_ADDRESS, data, value: nativeWei }).catch(() => undefined);
  const txs: Array<{ shape: TxShape; estimate?: bigint }> = [{ shape: { kind: 'buy', orders: loaded.length }, estimate }];
  if (approve) txs.unshift({ shape: { kind: 'approve', orders: 1 } });
  const fee = await networkFee(ctx.chains, chainId, txs);

  const plan: BuyPlan = {
    kind: 'buy',
    chainId,
    wallet,
    entries: loaded.map(({ order: _order, fees: _fees, ...entry }) => entry),
    totalValue: total,
    nativeValue: nativeWei,
    wrappedValue: wrappedWei,
    requiredAllowanceWei,
  };
  const markets = MARKETPLACES.filter(market => loaded.some(entry => entry.marketplace === market)).map(market => MARKETPLACE_NAME[market]).join(' + ');
  const card = new Card(loaded.length === 1 ? 'purchase' : `purchase of ${loaded.length} items`, chainId, { irreversible: true });
  const shown = new Set<string>();
  for (const entry of loaded) {
    const check = checkOf.get(entry.contract)!;
    const label = check.name === entry.contract ? shortHex(entry.contract) : check.name;
    const price = (wei: bigint) => amountLabel(wei, entry.currency, chainId);
    card.row(`${label} #${entry.tokenId}${entry.quantity > 1n ? ` ×${entry.quantity}` : ''}`, price(entry.value));
    card.text(`${MARKETPLACE_NAME[entry.marketplace]} · ${check.badge} · floor ${check.floorWei === null ? 'none' : native(check.floorWei, chainId)}`, 2);
    if (entry.fees) {
      card.row(`Gondi fee ${bpsLabel(GONDI_FEE_BPS)}`, price(entry.fees.gondiFeeWei), 4);
      if (entry.fees.otherFeesWei > 0n) card.row('Other fees', price(entry.fees.otherFeesWei), 4);
      card.row('Seller receives', price(entry.fees.sellerWei), 4);
    }
    const unitWei = entry.value / (entry.quantity > 0n ? entry.quantity : 1n);
    if (check.floorWei !== null && unitWei > check.floorWei * PRICE_OVER_FLOOR_FACTOR) card.warn(`This costs more than ${PRICE_OVER_FLOOR_FACTOR}x the collection floor (${native(check.floorWei, chainId)}).`, 2);
    if (!shown.has(entry.contract)) {
      shown.add(entry.contract);
      for (const warning of check.warnings) card.warn(warning, 2);
    }
  }
  const after = balance - nativeWei - (fee.nowWei ?? fee.maxWei);
  card.rule()
    .row('Total', totalLabel(nativeWei, wrappedWei, chainId))
    .row('Network fee', feeValue(fee, chainId))
    .row('Wallet after', `~${native(after > 0n ? after : 0n, chainId)}`);
  if (funding) card.row(`${WRAPPED_SYMBOL[chainId]} after`, wrapped(funding.balance - wrappedWei, chainId), 2);
  for (const warning of feeWarnings(fee)) card.warn(warning);
  if (approve) {
    card.row('Approve (1 transaction)', wrapped(requiredAllowanceWei!, chainId));
    card.text(`Seaport may spend exactly this: ${openOffers === null ? 'your current allowance (your open offers could not be loaded)' : `your open OSWiki offers ${wrapped(openOffers, chainId)}`} + this purchase, capped at your balance; never unlimited.`, 2);
    card.text('The purchase is simulated right before sending, after the approval.');
  } else {
    card.text('✓ Simulated just now: it goes through.');
  }
  card.details([`Seaport ${shortHex(SEAPORT_ADDRESS)}`, loaded.length === 1 ? `order ${shortHex(loaded[0]!.orderHash)}` : `${loaded.length} orders`, wrappedWei > 0n ? `${WRAPPED_SYMBOL[chainId]} ${shortHex(WRAPPED_NATIVE[chainId]!)}` : null]);
  const note = [
    `Buying ${loaded.length} ${markets} listing${loaded.length === 1 ? '' : 's'} for ${wallet} (wallet balance ${native(balance, chainId)}${funding ? `, ${wrapped(funding.balance, chainId)}` : ''}). ${fee.text}`,
    ...loaded.map(entry => `- ${entry.askId}: ${checkOf.get(entry.contract)!.name} ${entry.contract} #${entry.tokenId}${entry.quantity > 1n ? ` x${entry.quantity}` : ''} for ${amountLabel(entry.value, entry.currency, chainId)} on ${MARKETPLACE_NAME[entry.marketplace]}${entry.fees ? ` (Gondi fee ${amountLabel(entry.fees.gondiFeeWei, entry.currency, chainId)}${entry.fees.otherFeesWei > 0n ? `, other fees ${amountLabel(entry.fees.otherFeesWei, entry.currency, chainId)}` : ''}, seller receives ${amountLabel(entry.fees.sellerWei, entry.currency, chainId)})` : ''}`),
    approve ? `First approves exactly ${wrapped(requiredAllowanceWei!, chainId)} to Seaport ${SEAPORT_ADDRESS}, then one transaction to Seaport.` : `One transaction to Seaport ${SEAPORT_ADDRESS}.`,
  ];
  return { text: card.render(), plan, note };
}

function fillLine(entry: LoadedOrder, fill: FilledOrder | undefined, chainId: SupportedChainId): string {
  const amount = (wei: bigint) => amountLabel(wei, entry.currency, chainId);
  if (!fill || fill.received === 0n) return entry.currency === 'wrapped' ? `NOT filled (no ${WRAPPED_SYMBOL[chainId]} was taken)` : `NOT filled (${amount(entry.value)} refunded by Seaport)`;
  if (fill.received >= entry.quantity) return entry.quantity > 1n ? `bought ${fill.received}` : 'bought';
  const missing = entry.quantity - fill.received;
  const refunded = entry.value > fill.paid ? entry.value - fill.paid : 0n;
  return `bought ${fill.received} of ${entry.quantity} (${missing} ${missing === 1n ? 'was' : 'were'} sold to someone else first; the difference of ${amount(refunded)} was ${entry.currency === 'wrapped' ? 'not taken' : 'refunded'})`;
}

export async function executeBuy(ctx: Ctx, plan: BuyPlan, commit: () => void): Promise<string> {
  const { chainId } = plan;
  const wallet = me(ctx);
  if (plan.wallet !== wallet) throw new GuardError('This plan was made for another wallet.');
  const loaded = await Promise.all(plan.entries.map(entry => loadOrder(ctx, chainId, entry.askId, entry.value)));
  loaded.forEach((entry, i) => {
    const planned = plan.entries[i]!;
    if (entry.orderHash !== planned.orderHash || entry.value !== planned.value || entry.currency !== planned.currency || entry.contract !== planned.contract || entry.tokenId !== planned.tokenId || entry.quantity !== planned.quantity || entry.marketplace !== planned.marketplace) {
      throw new GuardError(`${entry.askId} changed since the preview. Run the preview again.`);
    }
    assertCollectionAllowed(ctx.config, entry.contract);
  });
  const { nativeWei, wrappedWei, total } = totals(loaded);
  if (total !== plan.totalValue || nativeWei !== plan.nativeValue || wrappedWei !== plan.wrappedValue) throw new GuardError('The total changed since the preview. Run the preview again.');
  assertMaxBuy(ctx.config, chainId, total, 'This purchase');

  let approveWei: bigint | null = null;
  if (wrappedWei > 0n) {
    const funding = await readWrappedFunding(ctx.chains.client(chainId), chainId, wallet);
    if (funding.balance < wrappedWei) throw new GuardError(`Not enough ${WRAPPED_SYMBOL[chainId]} any more: the purchase needs ${wrapped(wrappedWei, chainId)}, the wallet has ${wrapped(funding.balance, chainId)}. Nothing was sent.`);
    if (funding.allowance < (plan.requiredAllowanceWei ?? wrappedWei)) {
      if (plan.requiredAllowanceWei === null || plan.requiredAllowanceWei < wrappedWei) throw new GuardError(`Your ${WRAPPED_SYMBOL[chainId]} allowance to Seaport changed since the preview. Run the preview again.`);
      approveWei = plan.requiredAllowanceWei;
    }
  }
  if (approveWei === null) await simulateBuy(ctx, chainId, loaded, nativeWei);

  const log: string[] = [];
  commit();
  try {
    if (approveWei !== null) {
      const amount = approveWei;
      const approveData = encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'approve', args: [SEAPORT_ADDRESS, amount] });
      const approval = await txStep(log, `Approve ${wrapped(amount, chainId)} to Seaport`, () => sendGuardedTx(ctx.chains, ctx.account, { chainId, to: WRAPPED_NATIVE[chainId]!, data: approveData, value: 0n }, new Set()));
      log.push(`Approved exactly ${wrapped(amount, chainId)} to Seaport (tx ${approval.hash}).`);
      await simulateBuy(ctx, chainId, loaded, nativeWei);
    }
    const sent = await txStep(log, `Buy for ${totalLabel(nativeWei, wrappedWei, chainId)}`, () => sendGuardedTx(ctx.chains, ctx.account, { chainId, to: SEAPORT_ADDRESS, data: encodeBuy(loaded.map(entry => entry.order), wallet), value: nativeWei }, new Set()));
    const filled = filledOrders(sent.logs, new Map(loaded.map(entry => [entry.orderHash, { token: entry.contract, identifier: BigInt(entry.tokenId) }])));
    log.push(`Transaction ${sent.hash} confirmed.`);
    for (const entry of loaded) log.push(`- ${entry.askId}: ${fillLine(entry, filled.get(entry.orderHash), chainId)}`);
    return log.join('\n');
  } catch (err) {
    throw afterSends(log, err);
  }
}
