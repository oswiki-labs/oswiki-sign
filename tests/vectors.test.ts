import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { concat, hashStruct, keccak256, size, stringToHex, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { encodeFulfillAdvancedOrder, OSWIKI_DOMAIN_TAG } from '../src/abi.js';
import { getOswikiFeeRecipient, OPENSEA_CONDUIT_KEY, OPENSEA_FEE_RECIPIENT, SEAPORT_ADDRESS, WRAPPED_NATIVE } from '../src/constants.js';
import { assertOswikiSeaportOrder } from '../src/seaport/fulfill.js';
import { assertOswikiSeaportOffer, encodeOfferAccept } from '../src/seaport/offer.js';
import { buildOpenSeaOrder, usableOpenSeaTerms } from '../src/seaport/opensea.js';
import { buildListingOrder, buildOfferOrder, LISTING_START_SKEW_SECONDS, pickOrderComponents, type OrderComponents } from '../src/seaport/order.js';
import {
  BLANK_ORDER_COMPONENTS,
  bulkOrderProof,
  bulkOrderTypehash,
  bulkOrderTypes,
  buildBulkOrderLayers,
  computeBulkOrderProof,
  encodeBulkSignature,
  getBulkTreeHeight,
  hashOrderComponents,
  isBulkSignatureLength,
  recoverSeaportSigner,
  SEAPORT_ORDER_TYPEHASH,
  SeaportSignatureMismatchError,
  seaportDigest,
  seaportDomainSeparator,
  seaportOrderDigest,
  signSeaportBulkOrders,
  signSeaportOrder,
  verifySeaportOrderSignature,
} from '../src/seaport/sign.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { TEST_KEY } from './helpers.js';

const vectorSigner = privateKeyToAccount(vectors.signer.privateKey as Hex);
const otherSigner = privateKeyToAccount(TEST_KEY);
const erc721 = pickOrderComponents(vectors.orders.erc721.parameters);
const erc1155 = pickOrderComponents(vectors.orders.erc1155.parameters);

function flipByte(hex: Hex, byteIndex: number): Hex {
  const bytes = hex.slice(2).match(/../g)!;
  bytes[byteIndex] = ((parseInt(bytes[byteIndex]!, 16) ^ 0xff) & 0xff).toString(16).padStart(2, '0');
  return `0x${bytes.join('')}`;
}

function orderFor(tokenId: number, offerer: string = otherSigner.address.toLowerCase()): OrderComponents {
  return { ...erc721, offerer: offerer as `0x${string}`, offer: [{ ...erc721.offer[0]!, identifierOrCriteria: BigInt(tokenId) }] };
}

describe('Seaport EIP-712 constants', () => {
  it('derives the OrderComponents typehash and the domain separators on both chains', () => {
    const typeString = 'OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)'
      + 'ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)'
      + 'OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)';
    expect(keccak256(stringToHex(typeString))).toBe(SEAPORT_ORDER_TYPEHASH);
    expect(SEAPORT_ORDER_TYPEHASH).toBe(vectors.typehashes.orderComponents);
    expect(seaportDomainSeparator(1)).toBe(vectors.domains['1'].separator);
    expect(seaportDomainSeparator(33139)).toBe(vectors.domains['33139'].separator);
    expect(hashOrderComponents(BLANK_ORDER_COMPONENTS)).toBe(vectors.blankOrderHash);
    expect(vectors.seaport).toBe(SEAPORT_ADDRESS);
  });
});

describe('order hashes and digests', () => {
  it('reproduces the ERC-721 and ERC-1155 vectors', () => {
    expect(hashOrderComponents(erc721)).toBe(vectors.orders.erc721.orderHash);
    expect(seaportOrderDigest(1, erc721)).toBe(vectors.orders.erc721.digest);
    expect(seaportDigest(33139, vectors.orders.erc721.orderHash as Hex)).toBe(vectors.orders.erc721.apechain.digest);
    expect(hashOrderComponents(erc1155)).toBe(vectors.orders.erc1155.orderHash);
    expect(seaportOrderDigest(1, erc1155)).toBe(vectors.orders.erc1155.digest);
  });

  it('changes the hash when any field changes', () => {
    const base = hashOrderComponents(erc721);
    expect(hashOrderComponents({ ...erc721, counter: 1n })).not.toBe(base);
    expect(hashOrderComponents({ ...erc721, consideration: erc721.consideration.slice(0, 2) })).not.toBe(base);
  });
});

describe('signature recovery', () => {
  const { orderHash, digest, signature, signatureEip2098 } = vectors.orders.erc721;

  it('recovers 65-byte and EIP-2098 signatures, rejects v 0/1, the other chain and tampering', async () => {
    expect((await recoverSeaportSigner(digest as Hex, signature as Hex))?.toLowerCase()).toBe(vectors.signer.address);
    expect((await recoverSeaportSigner(digest as Hex, signatureEip2098 as Hex))?.toLowerCase()).toBe(vectors.signer.address);
    const v = parseInt(signature.slice(-2), 16) - 27;
    await expect(recoverSeaportSigner(digest as Hex, `${signature.slice(0, -2)}0${v}` as Hex)).resolves.toBeNull();
    await expect(verifySeaportOrderSignature({ chainId: 33139, offerer: vectors.signer.address, orderHash: orderHash as Hex, signature: signature as Hex })).resolves.toBe(false);
    await expect(verifySeaportOrderSignature({ chainId: 33139, offerer: vectors.signer.address, orderHash: orderHash as Hex, signature: vectors.orders.erc721.apechain.signature as Hex })).resolves.toBe(true);
    await expect(verifySeaportOrderSignature({ chainId: 1, offerer: vectors.signer.address, orderHash: orderHash as Hex, signature: flipByte(signature as Hex, 10) })).resolves.toBe(false);
  });
});

describe('signSeaportOrder with a local account', () => {
  it('reproduces the vector signature byte for byte on both chains', async () => {
    const signed = await signSeaportOrder(vectorSigner, erc721, { chainId: 1 });
    expect(signed.orderHash).toBe(vectors.orders.erc721.orderHash);
    expect(signed.signature).toBe(vectors.orders.erc721.signature);
    const ape = await signSeaportOrder(vectorSigner, erc721, { chainId: 33139 });
    expect(ape.signature).toBe(vectors.orders.erc721.apechain.signature);
    const multi = await signSeaportOrder(vectorSigner, erc1155, { chainId: 1 });
    expect(multi.signature).toBe(vectors.orders.erc1155.signature);
  });

  it('refuses to sign an order for another offerer', async () => {
    await expect(signSeaportOrder(otherSigner, erc721, { chainId: 1 })).rejects.toBeInstanceOf(SeaportSignatureMismatchError);
  });
});

describe('bulk trees (every leaf incl. padding)', () => {
  for (const tree of vectors.bulk) {
    it(`height ${tree.height}, ${tree.orderCount} orders: leaves, root, proofs and signatures byte for byte`, async () => {
      const padded = tree.leaves.map(leaf => pickOrderComponents(leaf.parameters));
      const leaves = padded.map(hashOrderComponents);
      const layers = buildBulkOrderLayers(leaves);
      expect(getBulkTreeHeight(tree.orderCount)).toBe(tree.height);
      expect(leaves).toEqual(tree.leaves.map(leaf => leaf.orderHash));
      expect(layers[tree.height]![0]).toBe(tree.root);
      expect(bulkOrderTypehash(tree.height)).toBe(tree.bulkOrderTypehash);
      expect(keccak256(concat([bulkOrderTypehash(tree.height), tree.root as Hex]))).toBe(tree.bulkOrderHash);
      expect(seaportDigest(1, tree.bulkOrderHash as Hex)).toBe(tree.digest);
      const nest = (items: OrderComponents[]): unknown => (items.length === 2 ? items : [nest(items.slice(0, items.length / 2)), nest(items.slice(items.length / 2))]);
      expect(hashStruct({ data: { tree: nest(padded) }, primaryType: 'BulkOrder', types: bulkOrderTypes(tree.height) })).toBe(tree.bulkOrderHash);

      for (const leaf of tree.leaves) {
        const proof = bulkOrderProof(layers, leaf.index);
        expect(proof).toEqual(leaf.proof);
        const full = encodeBulkSignature(tree.rootSignature as Hex, leaf.index, proof);
        expect(full).toBe(leaf.signature);
        expect(isBulkSignatureLength(size(full))).toBe(true);
        expect(computeBulkOrderProof(full, leaf.orderHash as Hex)).toMatchObject({ index: leaf.index, height: tree.height, root: tree.root, bulkOrderHash: tree.bulkOrderHash });
      }

      const orders = tree.leaves.filter(leaf => !leaf.padding).map(leaf => pickOrderComponents(leaf.parameters));
      const signed = await signSeaportBulkOrders(vectorSigner, orders, { chainId: 1 });
      expect(signed.map(entry => entry.signature)).toEqual(tree.leaves.slice(0, tree.orderCount).map(leaf => leaf.signature));
      expect(signed.map(entry => entry.orderHash)).toEqual(tree.leaves.slice(0, tree.orderCount).map(leaf => leaf.orderHash));
    });
  }

  it('rejects a tampered proof and the wrong leaf', async () => {
    const tree = vectors.bulk[1]!;
    const leaf = tree.leaves[0]!;
    await expect(verifySeaportOrderSignature({ chainId: 1, offerer: vectors.signer.address, orderHash: leaf.orderHash as Hex, signature: flipByte(leaf.signature as Hex, 65 + 3 + 5) })).resolves.toBe(false);
    await expect(verifySeaportOrderSignature({ chainId: 1, offerer: vectors.signer.address, orderHash: tree.leaves[1]!.orderHash as Hex, signature: leaf.signature as Hex })).resolves.toBe(false);
  });

  it('limits trees to height 10 and refuses mixed sellers', async () => {
    expect(getBulkTreeHeight(1)).toBe(1);
    expect(getBulkTreeHeight(3)).toBe(2);
    expect(getBulkTreeHeight(1024)).toBe(10);
    expect(() => getBulkTreeHeight(1025)).toThrow(/Maximum is 1024/);
    await expect(signSeaportBulkOrders(otherSigner, [orderFor(1), orderFor(2, vectors.signer.address)], { chainId: 1 })).rejects.toThrow(/same seller/);
  });

  it('signs an OSWiki order and its OpenSea twin under one root, every leaf verifies', async () => {
    const terms = usableOpenSeaTerms({
      chain: 'ape_chain',
      protocolAddress: SEAPORT_ADDRESS,
      conduitKey: OPENSEA_CONDUIT_KEY,
      zone: '0x000056f7000000ece9003ca63978907a00ffd100',
      orderType: 3,
      feeRecipient: OPENSEA_FEE_RECIPIENT,
      feeBps: 100,
      creatorFees: [{ recipient: '0x8888888888888888888888888888888888888888', bps: 690 }],
    }, 33139)!;
    const oswiki = [orderFor(1), orderFor(2), orderFor(3)];
    const all = [...oswiki, ...oswiki.map(order => buildOpenSeaOrder(order, terms))];
    const signed = await signSeaportBulkOrders(otherSigner, all, { chainId: 33139 });
    for (const entry of signed) {
      await expect(verifySeaportOrderSignature({ chainId: 33139, offerer: otherSigner.address, orderHash: entry.orderHash, signature: entry.signature })).resolves.toBe(true);
      expect(entry.bulk?.height).toBe(3);
      expect(size(entry.signature)).toBe(65 + 3 + 32 * 3);
    }
    expect(toHex(signed[4]!.bulk!.index, { size: 3 })).toBe('0x000004');
  });
});

describe('offer vectors', () => {
  const offers = vectors.offers;
  const singles = [
    { chainId: 1, vector: offers.offerErc721 },
    { chainId: 33139, vector: offers.offerErc721.apechain },
    { chainId: 1, vector: offers.offerErc1155 },
    { chainId: 33139, vector: offers.offerErc1155.apechain },
    { chainId: 1, vector: offers.offerCollection },
    { chainId: 33139, vector: offers.offerCollection.apechain },
  ];

  for (const [i, { chainId, vector }] of singles.entries()) {
    it(`offer vector ${i}: struct hash, digest and signature byte for byte`, async () => {
      const order = pickOrderComponents(vector.parameters);
      expect(hashOrderComponents(order)).toBe(vector.orderHash);
      expect(seaportOrderDigest(chainId, order)).toBe(vector.digest);
      expect((await signSeaportOrder(vectorSigner, order, { chainId })).signature).toBe(vector.signature);
    });
  }

  it('bulk collection offers: every leaf byte for byte', async () => {
    const tree = offers.offerCollectionBulk;
    const signed = await signSeaportBulkOrders(vectorSigner, tree.leaves.map(leaf => pickOrderComponents(leaf.parameters)), { chainId: 1 });
    expect(signed.map(entry => entry.signature)).toEqual(tree.leaves.map(leaf => leaf.signature));
  });

  it('item accept: guard passes and re-encodes the pinned calldata (with the OSWiki tag)', () => {
    for (const [vector, chainId, maker] of [[offers.offerErc721, 1, vectors.signer.address], [offers.offerErc1155, 1, vectors.signer.address], [offers.offerErc721.apechain, 33139, vectors.signer.address]] as const) {
      const bid = pickOrderComponents(vector.parameters);
      const nft = bid.consideration[0]!;
      const guarded = assertOswikiSeaportOffer({
        bidId: `oswiki-${vector.orderHash}`,
        kind: 'item',
        to: SEAPORT_ADDRESS,
        value: '0',
        method: 'fulfillBasicOrder_efficient_6GL6yc',
        amounts: { offerWei: '1000000000000000000', feeWei: '10000000000000000', royaltyWei: '50000000000000000', sellerNetWei: '940000000000000000' },
        approval: { token: nft.token, operator: '0x1e0049783f008a0085193e00003d00cd54003c71' },
        basicOrderParameters: vector.basicOrderParameters as unknown as Record<string, unknown>,
      }, { chainId, bidId: `oswiki-${vector.orderHash}`, maker, fulfiller: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', contract: nft.token, tokenId: nft.identifierOrCriteria.toString(), counter: 0n });
      expect(encodeOfferAccept(guarded)).toBe(vector.sentCalldata);
      expect(vector.sentCalldata.endsWith(OSWIKI_DOMAIN_TAG.slice(2))).toBe(true);
    }
  });

  it('collection accept: guard passes and re-encodes matchAdvancedOrders byte for byte', () => {
    const accept = offers.acceptCollection;
    const guarded = assertOswikiSeaportOffer({
      bidId: `oswiki-${accept.bidOrderHash}`,
      kind: 'collection',
      to: SEAPORT_ADDRESS,
      value: '0',
      method: 'matchAdvancedOrders',
      amounts: accept.amounts,
      approval: { token: '0x790b2cf29ed4f310bf7641f013c65d4560d28371', operator: '0x1e0049783f008a0085193e00003d00cd54003c71' },
      orders: accept.orders,
      criteriaResolvers: accept.criteriaResolvers,
      fulfillments: accept.fulfillments,
      recipient: accept.recipient,
    }, { chainId: 1, bidId: `oswiki-${accept.bidOrderHash}`, maker: vectors.signer.address, fulfiller: accept.fulfiller, contract: '0x790b2cf29ed4f310bf7641f013c65d4560d28371', tokenId: accept.tokenId, counter: 0n, nowSeconds: 1767226000 });
    expect(encodeOfferAccept(guarded)).toBe(accept.sentCalldata);
  });
});

describe('buy re-encoding', () => {
  it('guards the vector listing and encodes fulfillAdvancedOrder locally with the tag', () => {
    const guarded = assertOswikiSeaportOrder({
      to: SEAPORT_ADDRESS,
      value: '1000000000000000000',
      orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' },
    }, { tokenId: '1', contract: '0x790b2cf29ed4f310bf7641f013c65d4560d28371' });
    expect(guarded.value).toBe(10n ** 18n);
    const data = encodeFulfillAdvancedOrder(guarded.order, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect(data.slice(0, 10)).toBe('0xe7acab24');
    expect(data.endsWith('da32920a')).toBe(true);
  });
});

describe('order builders reproduce the vectors', () => {
  const VECTOR_START = 1767225600;
  const VECTOR_DURATION = 1798761600 - VECTOR_START;
  const now = VECTOR_START + LISTING_START_SKEW_SECONDS;

  it('buildListingOrder gives the ERC-721 and ERC-1155 listing struct hashes', () => {
    for (const [vector, isErc1155, quantity] of [[vectors.orders.erc721, false, 1n], [vectors.orders.erc1155, true, 5n]] as const) {
      const fixture = pickOrderComponents(vector.parameters);
      const order = buildListingOrder({
        offerer: vectors.signer.address,
        token: fixture.offer[0]!.token,
        tokenId: '1',
        isErc1155,
        quantity,
        unitPriceWei: 10n ** 18n / quantity,
        feeBps: 100,
        feeRecipient: getOswikiFeeRecipient(1),
        royaltyRecipient: '0x000000000000000000000000000000000000dead',
        royaltyWei: 5n * 10n ** 16n,
        counter: 0n,
        durationSeconds: VECTOR_DURATION,
        nowSeconds: now,
        salt: fixture.salt,
      });
      expect(order).toEqual(fixture);
      expect(hashOrderComponents(order)).toBe(vector.orderHash);
    }
  });

  it('buildOfferOrder gives every offer struct hash on both chains', () => {
    const cases = [
      [vectors.offers.offerErc721, 'item', false],
      [vectors.offers.offerErc1155, 'item', true],
      [vectors.offers.offerCollection, 'collection', false],
    ] as const;
    for (const [vector, kind, isErc1155] of cases) {
      for (const [chainId, entry] of [[1, vector], [33139, vector.apechain]] as const) {
        const fixture = pickOrderComponents(entry.parameters);
        const order = buildOfferOrder({
          offerer: vectors.signer.address,
          kind,
          token: fixture.consideration[0]!.token,
          tokenId: kind === 'item' ? '1' : null,
          isErc1155,
          currency: WRAPPED_NATIVE[chainId]!,
          amountWei: 10n ** 18n,
          feeWei: 10n ** 16n,
          feeRecipient: getOswikiFeeRecipient(chainId),
          royaltyRecipient: '0x000000000000000000000000000000000000dead',
          royaltyWei: 5n * 10n ** 16n,
          counter: 0n,
          durationSeconds: VECTOR_DURATION,
          nowSeconds: now,
          salt: fixture.salt,
        });
        expect(order).toEqual(fixture);
        expect(hashOrderComponents(order)).toBe(entry.orderHash);
      }
    }
  });

  const frontendFixture = process.env.OSWIKI_FRONTEND_VECTORS ?? fileURLToPath(new URL('../../frontend/tests/fixtures/seaport-vectors.json', import.meta.url));
  it.skipIf(!existsSync(frontendFixture))('the fixture is byte-identical to the frontend copy (line endings aside)', () => {
    const lf = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    expect(lf(fileURLToPath(new URL('./fixtures/seaport-vectors.json', import.meta.url)))).toBe(lf(frontendFixture));
  });
});
