import {
  compactSignatureToSignature,
  concat,
  getAddress,
  hashStruct,
  hashTypedData,
  hexToNumber,
  keccak256,
  parseCompactSignature,
  recoverAddress,
  serializeSignature,
  size,
  sliceHex,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem';

import { SEAPORT_ADDRESS, ZERO_ADDRESS, ZERO_BYTES32 } from '../constants.js';
import type { OrderComponents } from './order.js';

export const SEAPORT_DOMAIN_NAME = 'Seaport';
export const SEAPORT_DOMAIN_VERSION = '1.6';
export const SEAPORT_ORDER_TYPEHASH = '0xfa445660b7e21515a59617fcd68910b487aa5808b8abda3d78bc85df364b2c2f' as const;
export const SEAPORT_MAX_BULK_TREE_HEIGHT = 10;

export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

const REFERENCED_TYPE_STRINGS = [
  'ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)',
  'OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)',
  'OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)',
].join('');

export const BLANK_ORDER_COMPONENTS: OrderComponents = {
  offerer: ZERO_ADDRESS,
  zone: ZERO_ADDRESS,
  offer: [],
  consideration: [],
  orderType: 0,
  startTime: 0n,
  endTime: 0n,
  zoneHash: ZERO_BYTES32,
  salt: 0n,
  conduitKey: ZERO_BYTES32,
  counter: 0n,
};

export class SeaportSignatureMismatchError extends Error {
  constructor() {
    super('The signature does not recover to the wallet address. Nothing was submitted.');
    this.name = 'SeaportSignatureMismatchError';
  }
}

export function seaportDomain(chainId: number) {
  return {
    name: SEAPORT_DOMAIN_NAME,
    version: SEAPORT_DOMAIN_VERSION,
    chainId,
    verifyingContract: SEAPORT_ADDRESS,
  } as const;
}

/** The order id: EIP-712 struct hash of OrderComponents (not the digest). */
export function hashOrderComponents(order: OrderComponents): Hex {
  return hashStruct({ data: order, primaryType: 'OrderComponents', types: SEAPORT_ORDER_TYPES });
}

export function seaportDomainSeparator(chainId: number): Hex {
  return hashStruct({
    data: { ...seaportDomain(chainId), chainId: BigInt(chainId) },
    primaryType: 'EIP712Domain',
    types: { EIP712Domain: EIP712_DOMAIN_TYPE },
  });
}

export function seaportDigest(chainId: number, structHash: Hex): Hex {
  return keccak256(concat(['0x1901', seaportDomainSeparator(chainId), structHash]));
}

export function seaportOrderDigest(chainId: number, order: OrderComponents): Hex {
  return hashTypedData({ domain: seaportDomain(chainId), types: SEAPORT_ORDER_TYPES, primaryType: 'OrderComponents', message: order });
}

export function bulkOrderTypes(height: number) {
  return {
    BulkOrder: [{ name: 'tree', type: `OrderComponents${'[2]'.repeat(height)}` }],
    ...SEAPORT_ORDER_TYPES,
  };
}

export function bulkOrderTypehash(height: number): Hex {
  return keccak256(stringToHex(`BulkOrder(OrderComponents${'[2]'.repeat(height)} tree)${REFERENCED_TYPE_STRINGS}`));
}

export function getBulkTreeHeight(count: number): number {
  if (!Number.isInteger(count) || count < 1) throw new Error('No orders to sign');
  const height = Math.max(Math.ceil(Math.log2(count)), 1);
  if (height > SEAPORT_MAX_BULK_TREE_HEIGHT) {
    throw new Error(`Too many orders: ${count}. Maximum is ${2 ** SEAPORT_MAX_BULK_TREE_HEIGHT} per signature.`);
  }
  return height;
}

function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concat([left, right]));
}

/** layers[0] = padded leaves, layers[height] = [root]; pairs are hashed unsorted, left || right. */
export function buildBulkOrderLayers(leaves: Hex[]): Hex[][] {
  const layers: Hex[][] = [leaves];
  while (layers[layers.length - 1]!.length > 1) {
    const current = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) next.push(hashPair(current[i]!, current[i + 1]!));
    layers.push(next);
  }
  return layers;
}

export function bulkOrderProof(layers: Hex[][], index: number): Hex[] {
  const proof: Hex[] = [];
  let position = index;
  for (let level = 0; level < layers.length - 1; level++) {
    proof.push(layers[level]![position ^ 1]!);
    position >>= 1;
  }
  return proof;
}

function nestTree<T>(items: T[]): unknown {
  if (items.length === 2) return items;
  const mid = items.length / 2;
  return [nestTree(items.slice(0, mid)), nestTree(items.slice(mid))];
}

export function encodeBulkSignature(signature: Hex, index: number, proof: Hex[]): Hex {
  return concat([signature, toHex(index, { size: 3 }), ...proof]);
}

/** Seaport's _isValidBulkOrderSize: (64 + x) + 3 + 32y with x in {0,1}, 1 <= y <= 24. */
export function isBulkSignatureLength(length: number): boolean {
  return length >= 99 && length <= 836 && (length % 32 === 3 || length % 32 === 4);
}

/** Port of Seaport's _computeBulkOrderProof: bit i of the 3-byte key places the node on the right at level i. */
export function computeBulkOrderProof(fullSignature: Hex, leaf: Hex): { signature: Hex; index: number; height: number; root: Hex; bulkOrderHash: Hex } {
  const fullLength = size(fullSignature);
  if (!isBulkSignatureLength(fullLength)) throw new Error('Not a bulk order signature');
  const signatureLength = 65 - (fullLength & 1);
  const height = (fullLength - signatureLength) >> 5;
  const signature = sliceHex(fullSignature, 0, signatureLength);
  const key = hexToNumber(sliceHex(fullSignature, signatureLength, signatureLength + 3));

  let node = leaf;
  for (let level = 0; level < height; level++) {
    const start = signatureLength + 3 + level * 32;
    const sibling = sliceHex(fullSignature, start, start + 32);
    node = (key >> level) & 1 ? hashPair(sibling, node) : hashPair(node, sibling);
  }

  return { signature, index: key, height, root: node, bulkOrderHash: keccak256(concat([bulkOrderTypehash(height), node])) };
}

/** ecrecover the way Seaport does it: 65 bytes with v 27/28, or 64-byte EIP-2098. */
export async function recoverSeaportSigner(digest: Hex, signature: Hex): Promise<Address | null> {
  try {
    const signatureSize = size(signature);
    let full: Hex;
    if (signatureSize === 64) {
      full = serializeSignature(compactSignatureToSignature(parseCompactSignature(signature)));
    } else if (signatureSize === 65) {
      const v = hexToNumber(sliceHex(signature, 64, 65));
      if (v !== 27 && v !== 28) return null;
      full = signature;
    } else {
      return null;
    }
    return getAddress(await recoverAddress({ hash: digest, signature: full }));
  } catch {
    return null;
  }
}

/** Mirrors Seaport's _verifySignature for EOAs: bulk detected by length, ecrecover against the (bulk) digest. */
export async function verifySeaportOrderSignature(input: { chainId: number; offerer: string; orderHash: Hex; signature: Hex }): Promise<boolean> {
  let digest = seaportDigest(input.chainId, input.orderHash);
  let ecdsaSignature = input.signature;
  if (isBulkSignatureLength(size(input.signature))) {
    const proof = computeBulkOrderProof(input.signature, input.orderHash);
    digest = seaportDigest(input.chainId, proof.bulkOrderHash);
    ecdsaSignature = proof.signature;
  }
  const recovered = await recoverSeaportSigner(digest, ecdsaSignature);
  return !!recovered && recovered.toLowerCase() === input.offerer.toLowerCase();
}

export interface TypedDataSigner {
  address: Address;
  signTypedData: (typedData: {
    domain: ReturnType<typeof seaportDomain>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
}

/** Local keys always return v 27/28; anything else is normalised the way Seaport reads it. */
function normalizeV(signature: Hex): Hex {
  if (size(signature) !== 65) return signature;
  const v = hexToNumber(sliceHex(signature, 64, 65));
  if (v === 0 || v === 1) return concat([sliceHex(signature, 0, 64), toHex(v + 27, { size: 1 })]);
  return signature;
}

function lowercaseAddresses(value: unknown): unknown {
  if (typeof value === 'string') return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(lowercaseAddresses);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, lowercaseAddresses(entry)]));
  }
  return value;
}

export interface SignedSeaportOrder {
  order: OrderComponents;
  orderHash: Hex;
  signature: Hex;
  bulk?: { index: number; height: number; proof: Hex[] };
}

export async function signSeaportOrder(signer: TypedDataSigner, order: OrderComponents, options: { chainId: number }): Promise<SignedSeaportOrder> {
  if (order.offerer.toLowerCase() !== signer.address.toLowerCase()) throw new SeaportSignatureMismatchError();
  const signature = normalizeV(await signer.signTypedData({
    domain: seaportDomain(options.chainId),
    types: SEAPORT_ORDER_TYPES,
    primaryType: 'OrderComponents',
    message: lowercaseAddresses(order) as Record<string, unknown>,
  }));
  const orderHash = hashOrderComponents(order);
  if (!await verifySeaportOrderSignature({ chainId: options.chainId, offerer: order.offerer, orderHash, signature })) {
    throw new SeaportSignatureMismatchError();
  }
  return { order, orderHash, signature };
}

/** One signature for 2-1024 orders; each result carries sig || 3-byte index || proof. */
export async function signSeaportBulkOrders(signer: TypedDataSigner, orders: OrderComponents[], options: { chainId: number }): Promise<SignedSeaportOrder[]> {
  const height = getBulkTreeHeight(orders.length);
  const offerer = orders[0]!.offerer.toLowerCase();
  if (orders.some(order => order.offerer.toLowerCase() !== offerer)) {
    throw new Error('Every order in a bulk signature must have the same seller');
  }
  if (offerer !== signer.address.toLowerCase()) throw new SeaportSignatureMismatchError();

  const padded = [...orders];
  while (padded.length < 2 ** height) padded.push(BLANK_ORDER_COMPONENTS);
  const leaves = padded.map(hashOrderComponents);
  const layers = buildBulkOrderLayers(leaves);
  const root = layers[height]![0]!;

  const rootSignature = normalizeV(await signer.signTypedData({
    domain: seaportDomain(options.chainId),
    types: bulkOrderTypes(height),
    primaryType: 'BulkOrder',
    message: { tree: lowercaseAddresses(nestTree(padded)) },
  }));

  const signed = orders.map((order, index) => {
    const proof = bulkOrderProof(layers, index);
    return { order, orderHash: leaves[index]!, signature: encodeBulkSignature(rootSignature, index, proof), bulk: { index, height, proof } };
  });

  const bulkOrderHash = keccak256(concat([bulkOrderTypehash(height), root]));
  for (const entry of signed) {
    if (computeBulkOrderProof(entry.signature, entry.orderHash).bulkOrderHash !== bulkOrderHash) {
      throw new Error('Bulk order proof does not reconstruct the signed root');
    }
    if (!await verifySeaportOrderSignature({ chainId: options.chainId, offerer, orderHash: entry.orderHash, signature: entry.signature })) {
      throw new SeaportSignatureMismatchError();
    }
  }
  return signed;
}
