import { encodeFunctionData, type Hex } from 'viem';

import { SEAPORT_CANCEL_ABI, withDomainTag } from '../abi.js';
import { orderHashFromAskId } from './fulfill.js';
import { crossListingComponents } from './opensea.js';
import { pickOrderComponents, type OrderComponents } from './order.js';
import { hashOrderComponents } from './sign.js';

export const MAX_ORDERS_PER_CANCEL_TX = 50;

export interface SeaportCancelTarget {
  id: string;
  orderHash: Hex;
  components: OrderComponents;
  /** Set on a linked OpenSea order, cancelled together with its OSWiki listing. */
  twinOf?: string;
}

/** The rebuilt struct hash must equal the id: cancelling anything else costs gas and leaves the real order live. */
export function prepareSeaportCancel(id: string, orderData: Record<string, unknown> | null | undefined, offerer: string): SeaportCancelTarget {
  const components = pickOrderComponents(orderData);
  if (components.offerer !== offerer.toLowerCase()) throw new Error(`Only the maker can cancel ${id}`);
  const orderHash = hashOrderComponents(components);
  if (orderHashFromAskId(id) !== orderHash) throw new Error(`Order data for ${id} does not match its order hash`);
  return { id, orderHash, components };
}

export function prepareListingCancels(
  id: string,
  orderData: Record<string, unknown> | null | undefined,
  twin: { orderHash?: unknown; parameters?: unknown; status?: unknown } | null | undefined,
  offerer: string,
): SeaportCancelTarget[] {
  const target = prepareSeaportCancel(id, orderData, offerer);
  const linked = crossListingComponents(twin, offerer);
  return linked ? [target, { id: `opensea-${linked.orderHash}`, orderHash: linked.orderHash, components: linked.components, twinOf: id }] : [target];
}

export function encodeSeaportCancel(orders: OrderComponents[]): Hex {
  return withDomainTag(encodeFunctionData({ abi: SEAPORT_CANCEL_ABI, functionName: 'cancel', args: [orders] }));
}

export function chunkCancels(targets: SeaportCancelTarget[]): SeaportCancelTarget[][] {
  const unique = [...new Map(targets.map(target => [target.orderHash, target])).values()];
  const chunks: SeaportCancelTarget[][] = [];
  for (let i = 0; i < unique.length; i += MAX_ORDERS_PER_CANCEL_TX) chunks.push(unique.slice(i, i + MAX_ORDERS_PER_CANCEL_TX));
  return chunks;
}
