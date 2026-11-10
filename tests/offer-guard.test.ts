import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';

import { OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_ADDRESS, ZERO_BYTES32 } from '../src/constants.js';
import {
  assertOfferRequirements,
  assertOswikiSeaportOffer,
  OfferGuardError,
  OfferRequirementsError,
  readOfferFunding,
  type AcceptOfferData,
  type OfferAcceptExpectation,
  type OfferItemRequest,
  type OfferRequirements,
} from '../src/seaport/offer.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { COLLECTION, MAINNET_FEE_RECIPIENT, ROYALTY_RECIPIENT, TEST_ADDRESS } from './helpers.js';

type Json = Record<string, unknown>;
type Mutation<E> = (data: Json, extra: E) => unknown;
type Case<E> = [name: string, reason: string, mutate: Mutation<E>];

const offers = vectors.offers;
const accept = offers.acceptCollection;
const PRISTINE = JSON.stringify(offers);
const ONE = 10n ** 18n;
const NOW = 1767226000;
const BIDDER = vectors.signer.address;
const OTHER = '0x1111111111111111111111111111111111111111';
const WAPE = WRAPPED_NATIVE[33139]!;
const APE_FEE_RECIPIENT = '0x70a5af9ff16b9c436dbe6c1796930f4e1795abc6';
const SEAPORT_15 = '0x00000000000000adc04c56bf30ac9d3c0aaf14dc';
const NONZERO_BYTES32 = `0x${'01'.repeat(32)}`;
const UINT256_OVERFLOW = (1n << 256n).toString();
const BP = 'basicOrderParameters';
const BID = 'orders.0.parameters';
const MIRROR = 'orders.1.parameters';

function get(data: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Json)[key], data);
}

function at<E>(path: string, value: unknown): Mutation<E> {
  return (data) => {
    const keys = path.split('.');
    const last = keys.pop()!;
    (keys.length ? get(data, keys.join('.')) as Json : data)[last] = value;
  };
}

function edit<E>(path: string, change: (list: Json[]) => unknown): Mutation<E> {
  return (data) => {
    change(get(data, path) as Json[]);
  };
}

function all<E>(...mutations: Array<Mutation<E>>): Mutation<E> {
  return (data, extra) => {
    for (const mutate of mutations) mutate(data, extra);
  };
}

function exp(patch: Partial<OfferAcceptExpectation>): Mutation<OfferAcceptExpectation> {
  return (_data, expected) => {
    Object.assign(expected, patch);
  };
}

interface AcceptBase {
  data: Json;
  expected: OfferAcceptExpectation;
}

function itemBase(vector: { orderHash: string; basicOrderParameters: object } = offers.offerErc721, chainId = 1): AcceptBase {
  const bidId = `oswiki-${vector.orderHash}`;
  return {
    data: {
      bidId,
      kind: 'item',
      to: SEAPORT_ADDRESS,
      value: '0',
      method: 'fulfillBasicOrder_efficient_6GL6yc',
      amounts: { offerWei: '1000000000000000000', feeWei: '10000000000000000', royaltyWei: '50000000000000000', sellerNetWei: '940000000000000000' },
      approval: { token: COLLECTION, operator: OPENSEA_CONDUIT_ADDRESS },
      basicOrderParameters: structuredClone(vector.basicOrderParameters),
    },
    expected: { chainId, bidId, maker: BIDDER, fulfiller: TEST_ADDRESS, contract: COLLECTION, tokenId: '1', kind: 'item', counter: 0n },
  };
}

function collectionBase(): AcceptBase {
  const bidId = `oswiki-${accept.bidOrderHash}`;
  return {
    data: {
      bidId,
      kind: 'collection',
      to: SEAPORT_ADDRESS,
      value: '0',
      method: 'matchAdvancedOrders',
      amounts: structuredClone(accept.amounts),
      approval: { token: COLLECTION, operator: OPENSEA_CONDUIT_ADDRESS },
      orders: structuredClone(accept.orders),
      criteriaResolvers: structuredClone(accept.criteriaResolvers),
      fulfillments: structuredClone(accept.fulfillments),
      recipient: accept.recipient,
    },
    expected: { chainId: 1, bidId, maker: BIDDER, fulfiller: accept.fulfiller, contract: COLLECTION, tokenId: accept.tokenId, kind: 'collection', counter: 0n, nowSeconds: NOW },
  };
}

function rejection(base: AcceptBase, mutate: Mutation<OfferAcceptExpectation>): string {
  const replaced = mutate(base.data, base.expected);
  try {
    assertOswikiSeaportOffer((replaced === undefined ? base.data : replaced) as AcceptOfferData, base.expected);
  } catch (err) {
    expect(err).toBeInstanceOf(OfferGuardError);
    return (err as Error).message;
  }
  throw new Error('the guard accepted the mutated accept data');
}

const guardMessage = (reason: string) => new OfferGuardError(reason).message;

describe('accept guard: unmutated bases pass', () => {
  it.each([
    ['ERC-721 item offer on mainnet', () => itemBase()],
    ['ERC-1155 item offer on mainnet', () => itemBase(offers.offerErc1155)],
    ['ERC-721 item offer on ApeChain', () => itemBase(offers.offerErc721.apechain, 33139)],
  ])('%s', (_name, base) => {
    const { data, expected } = base();
    const guarded = assertOswikiSeaportOffer(data as AcceptOfferData, expected);
    expect(guarded.kind).toBe('item');
    expect(guarded.contract).toBe(COLLECTION);
    expect(guarded.tokenId).toBe(1n);
    expect(guarded.amounts).toEqual({ offerWei: ONE, feeWei: ONE / 100n, royaltyWei: ONE / 20n, sellerNetWei: ONE - ONE / 100n - ONE / 20n });
  });

  it('collection offer with the unsigned seller mirror', () => {
    const { data, expected } = collectionBase();
    const guarded = assertOswikiSeaportOffer(data as AcceptOfferData, expected);
    expect(guarded.kind).toBe('collection');
    expect(guarded.tokenId).toBe(42n);
    if (guarded.kind === 'collection') expect(guarded.recipient).toBe(accept.fulfiller);
  });

  it('tolerates the currency as a string or an object and a mirror on its time-window edges', () => {
    for (const currency of [WRAPPED_NATIVE[1]!, { address: WRAPPED_NATIVE[1]!.toUpperCase().replace('0X', '0x'), symbol: 'WETH', decimals: 18 }]) {
      const { data, expected } = itemBase();
      expect(() => assertOswikiSeaportOffer({ ...data, currency } as AcceptOfferData, expected)).not.toThrow();
    }
    for (const [path, value] of [[`${MIRROR}.startTime`, String(NOW + 300)], [`${MIRROR}.endTime`, String(NOW + 1)]] as const) {
      const { data, expected } = collectionBase();
      at(path, value)(data, expected);
      expect(() => assertOswikiSeaportOffer(data as AcceptOfferData, expected)).not.toThrow();
    }
  });
});

const preambleCases: Array<Case<OfferAcceptExpectation>> = [
  ['no accept data', 'missing accept data', () => null],
  ['accept data that is a string', 'missing accept data', () => 'accept'],
  ['an unsupported chain', 'unsupported chain', exp({ chainId: 5 })],
  ['a malformed fulfiller', 'invalid address', exp({ fulfiller: '0x1234' })],
  ['a malformed expected contract', 'invalid address', exp({ contract: 'otherdeed' })],
  ['a hex token id', 'invalid token id', exp({ tokenId: '0x1' })],
  ['a token id with a leading zero', 'invalid token id', exp({ tokenId: '01' })],
  ['accept data for another bidId', 'accept data is for another offer', at('bidId', `oswiki-0x${'ab'.repeat(32)}`)],
  ['accept data without a bidId', 'accept data is for another offer', at('bidId', undefined)],
  ['Seaport 1.5 as the target', 'target is not Seaport 1.6', at('to', SEAPORT_15)],
  ['no target', 'target is not Seaport 1.6', at('to', undefined)],
  ['a non-zero value', 'value must be 0', at('value', '1')],
  ['no value', 'value must be 0', at('value', undefined)],
  ['the collection kind for an item offer', 'offer kind mismatch', at('kind', 'collection')],
  ['an approval for another collection', 'unexpected approval target', at('approval.token', OTHER)],
  ['an approval to another operator', 'unexpected approval target', at('approval.operator', OTHER)],
  ['an approval to Seaport itself', 'unexpected approval target', at('approval.operator', SEAPORT_ADDRESS)],
  ['no approval', 'unexpected approval target', at('approval', null)],
  ['a foreign currency string', 'unexpected currency', at('currency', OTHER)],
  ['the ApeChain currency object on mainnet', 'unexpected currency', at('currency', { address: WAPE, symbol: 'WAPE', decimals: 18 })],
  ['a currency object with a null address', 'unexpected currency', at('currency', { address: null })],
  ['no amounts', 'missing amounts', at('amounts', null)],
  ['a numeric offerWei', 'invalid offerWei', at('amounts.offerWei', 1e18)],
  ['a negative feeWei', 'invalid feeWei', at('amounts.feeWei', '-1')],
  ['a hex royaltyWei', 'invalid royaltyWei', at('amounts.royaltyWei', '0x10')],
  ['no sellerNetWei', 'invalid sellerNetWei', at('amounts.sellerNetWei', undefined)],
  ['an unknown kind when the caller names none', 'unknown offer kind', all(exp({ kind: undefined }), at('kind', 'trait'))],
];

describe('accept guard: shared checks before the route', () => {
  it.each(preambleCases)('refuses %s', (_name, reason, mutate) => {
    expect(rejection(itemBase(), mutate)).toBe(guardMessage(reason));
  });
});

const basicParseCases: Array<[string, unknown, string]> = [
  ['offerer', '0x1234', 'Invalid offerer'],
  ['offerToken', null, 'Invalid offerToken'],
  ['offerAmount', '1e18', 'Invalid offerAmount'],
  ['additionalRecipients.0', null, 'Invalid additionalRecipients[0].amount'],
  ['additionalRecipients.0.amount', -1, 'Invalid additionalRecipients[0].amount'],
  ['additionalRecipients.1.recipient', 'dead', 'Invalid additionalRecipients[1].recipient'],
  ['considerationAmount', '01', 'Invalid considerationAmount'],
  ['zone', `0x${'00'.repeat(19)}`, 'Invalid zone'],
  ['offerIdentifier', 1.5, 'Invalid offerIdentifier'],
  ['considerationToken', 42, 'Invalid considerationToken'],
  ['considerationIdentifier', '', 'Invalid considerationIdentifier'],
  ['startTime', {}, 'Invalid startTime'],
  ['endTime', UINT256_OVERFLOW, 'Invalid endTime'],
  ['zoneHash', ZERO_ADDRESS, 'Invalid zoneHash'],
  ['salt', '-1', 'Invalid salt'],
  ['offererConduitKey', undefined, 'Invalid offererConduitKey'],
  ['totalOriginalAdditionalRecipients', 'two', 'Invalid totalOriginalAdditionalRecipients'],
];

const legs = (change: (list: Json[]) => unknown) => edit<OfferAcceptExpectation>(`${BP}.additionalRecipients`, change);

const itemCases: Array<Case<OfferAcceptExpectation>> = [
  ['the match route for an item offer', 'item offers fill through the basic route', at('method', 'matchAdvancedOrders')],
  ['no basic order parameters', 'missing basic order parameters', at(BP, null)],
  ['basicOrderType 17 (partial open)', 'basicOrderType must be 16 or 20', at(`${BP}.basicOrderType`, 17)],
  ['basicOrderType 18 (restricted)', 'basicOrderType must be 16 or 20', at(`${BP}.basicOrderType`, 18)],
  ['basicOrderType 8 (the buy route)', 'basicOrderType must be 16 or 20', at(`${BP}.basicOrderType`, 8)],
  ['no basicOrderType', 'basicOrderType must be 16 or 20', at(`${BP}.basicOrderType`, undefined)],
  ['no additional recipients array', 'missing additional recipients', at(`${BP}.additionalRecipients`, null)],
  ...basicParseCases.map(([field, value, reason]): Case<OfferAcceptExpectation> => [`a malformed ${field}`, reason, at(`${BP}.${field}`, value)]),
  ['another offerer', 'offerer is not the bid maker', at(`${BP}.offerer`, OTHER)],
  ['a maker that is not the bid offerer', 'offerer is not the bid maker', exp({ maker: OTHER })],
  ['a zone', 'zone must be 0', at(`${BP}.zone`, OTHER)],
  ['a zoneHash', 'zone must be 0', at(`${BP}.zoneHash`, NONZERO_BYTES32)],
  ['an offerer conduit', 'offer conduitKey must be 0', at(`${BP}.offererConduitKey`, OPENSEA_CONDUIT_KEY)],
  ['WAPE offered on mainnet', 'offer must be the wrapped native token', at(`${BP}.offerToken`, WAPE)],
  ['an offer identifier', 'offer must be the wrapped native token', at(`${BP}.offerIdentifier`, '1')],
  ['an offer above the quote', 'offer amount mismatch', at(`${BP}.offerAmount`, '2000000000000000000')],
  ['an offer 1 wei below the quote', 'offer amount mismatch', at(`${BP}.offerAmount`, '999999999999999999')],
  ['another collection', 'consideration is not this collection', at(`${BP}.considerationToken`, OTHER)],
  ['two units of the NFT', 'NFT amount must be 1', at(`${BP}.considerationAmount`, '2')],
  ['zero units of the NFT', 'NFT amount must be 1', at(`${BP}.considerationAmount`, '0')],
  ['another token id in the bid', 'offer is for another token', at(`${BP}.considerationIdentifier`, '2')],
  ['another token id from the caller', 'offer is for another token', exp({ tokenId: '2' })],
  ['a third payment leg', 'too many payment legs', all(legs(list => list.push({ amount: '1', recipient: OTHER })), at(`${BP}.totalOriginalAdditionalRecipients`, 3))],
  ['a zero payment leg', 'payment legs must be fixed', at(`${BP}.additionalRecipients.1.amount`, '0')],
  ['the royalty leg before the fee leg', 'fee leg out of place', legs(list => list.reverse())],
  ['two fee legs', 'fee leg out of place', at(`${BP}.additionalRecipients.1.recipient`, MAINNET_FEE_RECIPIENT)],
  ['a royalty leg to the zero address', 'unexpected payment recipient', at(`${BP}.additionalRecipients.1.recipient`, ZERO_ADDRESS)],
  ['a royalty leg back to the bidder', 'unexpected payment recipient', at(`${BP}.additionalRecipients.1.recipient`, BIDDER)],
  ['the fee leg redirected to another wallet', 'unexpected payment recipient', at(`${BP}.additionalRecipients.0.recipient`, OTHER)],
  ['totalOriginalAdditionalRecipients below the legs', 'totalOriginalConsiderationItems mismatch', at(`${BP}.totalOriginalAdditionalRecipients`, 1)],
  ['totalOriginalAdditionalRecipients above the legs', 'totalOriginalConsiderationItems mismatch', at(`${BP}.totalOriginalAdditionalRecipients`, 3)],
  ['a fee quote that is not the fee leg', 'fee or royalty does not match the quote', at('amounts.feeWei', '20000000000000000')],
  ['a zero royalty quote next to a royalty leg', 'fee or royalty does not match the quote', at('amounts.royaltyWei', '0')],
  ['a fee 1 wei above 1%', 'fee too high', all(at(`${BP}.additionalRecipients.0.amount`, '10000000000000001'), at('amounts.feeWei', '10000000000000001'), at('amounts.sellerNetWei', '939999999999999999'))],
  ['a royalty 1 wei above 25%', 'royalty too high', all(at(`${BP}.additionalRecipients.1.amount`, '250000000000000001'), at('amounts.royaltyWei', '250000000000000001'), at('amounts.sellerNetWei', '739999999999999999'))],
  ['a seller net above what is left', 'seller net does not add up', at('amounts.sellerNetWei', '950000000000000000')],
  ['a seller net below what is left', 'seller net does not add up', at('amounts.sellerNetWei', '930000000000000000')],
  ['a zero offer that leaves the seller nothing', 'seller net does not add up', all(at(`${BP}.offerAmount`, '0'), at(`${BP}.additionalRecipients`, []), at(`${BP}.totalOriginalAdditionalRecipients`, 0), at('amounts', { offerWei: '0', feeWei: '0', royaltyWei: '0', sellerNetWei: '0' }))],
  ['no fulfiller conduit', 'fulfillerConduitKey must be the OpenSea key', at(`${BP}.fulfillerConduitKey`, ZERO_BYTES32)],
  ['a foreign fulfiller conduit', 'fulfillerConduitKey must be the OpenSea key', at(`${BP}.fulfillerConduitKey`, NONZERO_BYTES32)],
  ['totalOriginalAdditionalRecipients as hex', 'totalOriginalAdditionalRecipients mismatch', at(`${BP}.totalOriginalAdditionalRecipients`, '0x2')],
  ['an empty signature', 'missing signature', at(`${BP}.signature`, '0x')],
  ['an odd-length signature', 'missing signature', at(`${BP}.signature`, '0x123')],
  ['no signature', 'missing signature', at(`${BP}.signature`, undefined)],
  ['a moved counter', 'order does not hash to this offer', exp({ counter: 1n })],
  ['another salt', 'order does not hash to this offer', at(`${BP}.salt`, '1')],
  ['a later end time', 'order does not hash to this offer', at(`${BP}.endTime`, '1798761601')],
  ['the ERC-1155 route for an ERC-721 bid', 'order does not hash to this offer', at(`${BP}.basicOrderType`, 20)],
  ['a consistent royalty of exactly 25%', 'order does not hash to this offer', all(at(`${BP}.additionalRecipients.1.amount`, '250000000000000000'), at('amounts.royaltyWei', '250000000000000000'), at('amounts.sellerNetWei', '740000000000000000'))],
  ['a bidId swapped in both data and caller', 'order does not hash to this offer', all(at('bidId', `oswiki-0x${'ab'.repeat(32)}`), exp({ bidId: `oswiki-0x${'ab'.repeat(32)}` }))],
];

describe('accept guard: item offers (fulfillBasicOrder)', () => {
  it.each(itemCases)('refuses %s', (_name, reason, mutate) => {
    expect(rejection(itemBase(), mutate)).toBe(guardMessage(reason));
  });

  it('refuses the ERC-721 route for an ERC-1155 bid', () => {
    expect(rejection(itemBase(offers.offerErc1155), at(`${BP}.basicOrderType`, 16))).toBe(guardMessage('order does not hash to this offer'));
  });

  it('refuses an ApeChain bid checked as mainnet and the mainnet fee recipient on ApeChain', () => {
    const ape = () => itemBase(offers.offerErc721.apechain, 33139);
    expect(rejection(ape(), exp({ chainId: 1 }))).toBe(guardMessage('offer must be the wrapped native token'));
    expect(rejection(ape(), at(`${BP}.additionalRecipients.0.recipient`, MAINNET_FEE_RECIPIENT))).toBe(guardMessage('unexpected payment recipient'));
    expect(rejection(itemBase(), at(`${BP}.additionalRecipients.0.recipient`, APE_FEE_RECIPIENT))).toBe(guardMessage('unexpected payment recipient'));
  });
});

const orderParseCases: Array<[string, unknown, string]> = [
  ['offerer', '0x1234', 'Invalid offerer'],
  ['zone', null, 'Invalid zone'],
  ['offer', {}, 'Invalid offer'],
  ['consideration', 'none', 'Invalid consideration'],
  ['orderType', 256, 'Invalid orderType'],
  ['startTime', -1, 'Invalid startTime'],
  ['endTime', '1.5', 'Invalid endTime'],
  ['zoneHash', '0x00', 'Invalid zoneHash'],
  ['salt', UINT256_OVERFLOW, 'Invalid salt'],
  ['conduitKey', OPENSEA_CONDUIT_KEY.slice(0, -2), 'Invalid conduitKey'],
  ['totalOriginalConsiderationItems', undefined, 'Invalid totalOriginalConsiderationItems'],
];

const bidConsideration = (change: (list: Json[]) => unknown) => edit<OfferAcceptExpectation>(`${BID}.consideration`, change);
const fulfillments = (change: (list: Json[]) => unknown) => edit<OfferAcceptExpectation>('fulfillments', change);

const collectionCases: Array<Case<OfferAcceptExpectation>> = [
  ['the basic route for a collection offer', 'collection offers fill through matchAdvancedOrders', at('method', 'fulfillBasicOrder_efficient_6GL6yc')],
  ['the item kind for a collection offer', 'offer kind mismatch', at('kind', 'item')],
  ['only the bid order', 'exactly two orders required', edit('orders', list => list.pop())],
  ['a third order', 'exactly two orders required', edit('orders', list => list.push(structuredClone(list[1]!)))],
  ['orders that are not an array', 'exactly two orders required', at('orders', null)],
  ['a null bid order', 'Invalid order parameters', at('orders.0', null)],
  ['mirror parameters given as an array', 'Invalid order parameters', at(MIRROR, [])],
  ...orderParseCases.flatMap(([field, value, reason]): Array<Case<OfferAcceptExpectation>> => [
    [`a malformed bid ${field}`, reason, at(`${BID}.${field}`, value)],
    [`a malformed mirror ${field}`, reason, at(`${MIRROR}.${field}`, value)],
  ]),
  ['an item type above 255 in the bid', 'Invalid consideration[0].itemType', at(`${BID}.consideration.0.itemType`, 256)],
  ['a malformed token in the mirror offer', 'Invalid offer[0].token', at(`${MIRROR}.offer.0.token`, '0x')],
  ['another bidder', 'offerer is not the bid maker', at(`${BID}.offerer`, OTHER)],
  ['a bid zone', 'zone must be 0', at(`${BID}.zone`, OTHER)],
  ['a bid zoneHash', 'zone must be 0', at(`${BID}.zoneHash`, NONZERO_BYTES32)],
  ['a bid offer conduit', 'offer conduitKey must be 0', at(`${BID}.conduitKey`, OPENSEA_CONDUIT_KEY)],
  ['a partial-open bid', 'orderType must be FULL_OPEN', at(`${BID}.orderType`, 1)],
  ['a restricted bid', 'orderType must be FULL_OPEN', at(`${BID}.orderType`, 2)],
  ['a bid offering nothing', 'exactly one offer item required', at(`${BID}.offer`, [])],
  ['a bid offering two items', 'exactly one offer item required', edit(`${BID}.offer`, list => list.push(structuredClone(list[0]!)))],
  ['native ETH offered', 'offer must be the wrapped native token', at(`${BID}.offer.0.itemType`, 0)],
  ['another ERC-20 offered', 'offer must be the wrapped native token', at(`${BID}.offer.0.token`, OTHER)],
  ['an offer identifier', 'offer must be the wrapped native token', at(`${BID}.offer.0.identifierOrCriteria`, '1')],
  ['a declining offer amount', 'offer amount mismatch', at(`${BID}.offer.0.endAmount`, '900000000000000000')],
  ['an offer above the quote', 'offer amount mismatch', all(at(`${BID}.offer.0.startAmount`, '2000000000000000000'), at(`${BID}.offer.0.endAmount`, '2000000000000000000'))],
  ['an empty consideration', 'empty consideration', at(`${BID}.consideration`, [])],
  ['another collection', 'consideration is not this collection', at(`${BID}.consideration.0.token`, OTHER)],
  ['two NFTs wanted', 'NFT amount must be 1', at(`${BID}.consideration.0.startAmount`, '2')],
  ['an NFT end amount of 2', 'NFT amount must be 1', at(`${BID}.consideration.0.endAmount`, '2')],
  ['the NFT sent to another wallet', 'NFT must go to the bidder', at(`${BID}.consideration.0.recipient`, OTHER)],
  ['a specific ERC-721 instead of criteria', 'collection offer must use criteria 0', at(`${BID}.consideration.0.itemType`, 2)],
  ['ERC-1155 criteria', 'collection offer must use criteria 0', at(`${BID}.consideration.0.itemType`, 5)],
  ['a criteria root (trait offer)', 'collection offer must use criteria 0', at(`${BID}.consideration.0.identifierOrCriteria`, '1')],
  ['a third payment leg', 'too many payment legs', all(bidConsideration(list => list.push(structuredClone(list[2]!))), at(`${BID}.totalOriginalConsiderationItems`, 4))],
  ['a native ETH fee leg', 'payment legs must be the offer currency', at(`${BID}.consideration.1.itemType`, 0)],
  ['a royalty leg in another token', 'payment legs must be the offer currency', at(`${BID}.consideration.2.token`, OTHER)],
  ['a payment leg with an identifier', 'payment legs must be the offer currency', at(`${BID}.consideration.1.identifierOrCriteria`, '1')],
  ['a zero royalty leg', 'payment legs must be fixed', all(at(`${BID}.consideration.2.startAmount`, '0'), at(`${BID}.consideration.2.endAmount`, '0'))],
  ['an ascending royalty leg', 'payment legs must be fixed', at(`${BID}.consideration.2.endAmount`, '60000000000000000')],
  ['the royalty leg before the fee leg', 'fee leg out of place', bidConsideration(list => list.splice(1, 2, list[2]!, list[1]!))],
  ['a royalty leg to the zero address', 'unexpected payment recipient', at(`${BID}.consideration.2.recipient`, ZERO_ADDRESS)],
  ['a royalty leg back to the bidder', 'unexpected payment recipient', at(`${BID}.consideration.2.recipient`, BIDDER)],
  ['a tip slot beyond the original consideration', 'totalOriginalConsiderationItems mismatch', at(`${BID}.totalOriginalConsiderationItems`, 2)],
  ['no royalty leg while the quote has one', 'fee or royalty does not match the quote', all(bidConsideration(list => list.pop()), at(`${BID}.totalOriginalConsiderationItems`, 2))],
  ['a half fill of the bid', 'orders must fill whole', at('orders.0.denominator', 2)],
  ['a zero numerator on the mirror', 'orders must fill whole', at('orders.1.numerator', 0)],
  ['extraData on the bid', 'zone-0 orders carry no extraData', at('orders.0.extraData', '0x00')],
  ['no extraData on the mirror', 'zone-0 orders carry no extraData', at('orders.1.extraData', undefined)],
  ['an empty bid signature', 'missing bid signature', at('orders.0.signature', '0x')],
  ['a non-hex bid signature', 'missing bid signature', at('orders.0.signature', 'signature')],
  ['a mirror from another wallet', 'mirror offerer is not you', at(`${MIRROR}.offerer`, OTHER)],
  ['a caller wallet that is not the mirror offerer', 'mirror offerer is not you', exp({ fulfiller: OTHER })],
  ['a mirror zone', 'mirror must be zone 0, FULL_OPEN', at(`${MIRROR}.zone`, OTHER)],
  ['a mirror zoneHash', 'mirror must be zone 0, FULL_OPEN', at(`${MIRROR}.zoneHash`, NONZERO_BYTES32)],
  ['a partial-open mirror', 'mirror must be zone 0, FULL_OPEN', at(`${MIRROR}.orderType`, 1)],
  ['a mirror without the OpenSea conduit', 'mirror conduitKey must be the OpenSea key', at(`${MIRROR}.conduitKey`, ZERO_BYTES32)],
  ['a signed mirror', 'mirror must be unsigned', at('orders.1.signature', accept.orders[0]!.signature)],
  ['a mirror offering nothing', 'mirror must offer exactly this NFT', at(`${MIRROR}.offer`, [])],
  ['a mirror offering a second NFT', 'mirror must offer exactly this NFT', edit(`${MIRROR}.offer`, list => list.push({ ...list[0]!, identifierOrCriteria: '43' }))],
  ['a mirror offering the NFT as ERC-1155', 'mirror must offer exactly this NFT', at(`${MIRROR}.offer.0.itemType`, 3)],
  ['a mirror offering another collection', 'mirror must offer exactly this NFT', at(`${MIRROR}.offer.0.token`, OTHER)],
  ['a mirror offering another token', 'mirror must offer exactly this NFT', at(`${MIRROR}.offer.0.identifierOrCriteria`, '43')],
  ['a mirror offering two units', 'mirror must offer exactly this NFT', at(`${MIRROR}.offer.0.startAmount`, '2')],
  ['a mirror offer end amount of 2', 'mirror must offer exactly this NFT', at(`${MIRROR}.offer.0.endAmount`, '2')],
  ['a seller token that is not the mirror token', 'mirror must offer exactly this NFT', exp({ tokenId: '43' })],
  ['a mirror asking a second payment', 'mirror must ask exactly the seller net', edit(`${MIRROR}.consideration`, list => list.push({ ...list[0]!, startAmount: '1', endAmount: '1', recipient: OTHER }))],
  ['a mirror asking native ETH', 'mirror must ask exactly the seller net', at(`${MIRROR}.consideration.0.itemType`, 0)],
  ['a mirror asking another token', 'mirror must ask exactly the seller net', at(`${MIRROR}.consideration.0.token`, OTHER)],
  ['a mirror ask with an identifier', 'mirror must ask exactly the seller net', at(`${MIRROR}.consideration.0.identifierOrCriteria`, '1')],
  ['a mirror asking less than the seller net', 'mirror must ask exactly the seller net', all(at(`${MIRROR}.consideration.0.startAmount`, '930000000000000000'), at(`${MIRROR}.consideration.0.endAmount`, '930000000000000000'))],
  ['a mirror asking more than the seller net', 'mirror must ask exactly the seller net', all(at(`${MIRROR}.consideration.0.startAmount`, '950000000000000000'), at(`${MIRROR}.consideration.0.endAmount`, '950000000000000000'))],
  ['a mirror with a declining ask', 'mirror must ask exactly the seller net', at(`${MIRROR}.consideration.0.endAmount`, '930000000000000000')],
  ['mirror proceeds to another wallet', 'mirror must ask exactly the seller net', at(`${MIRROR}.consideration.0.recipient`, OTHER)],
  ['a mirror totalOriginalConsiderationItems of 0', 'mirror totalOriginalConsiderationItems mismatch', at(`${MIRROR}.totalOriginalConsiderationItems`, 0)],
  ['a mirror totalOriginalConsiderationItems of 2', 'mirror totalOriginalConsiderationItems mismatch', at(`${MIRROR}.totalOriginalConsiderationItems`, 2)],
  ['an expired mirror', 'mirror is outside its time window', exp({ nowSeconds: 1767227400 })],
  ['a mirror ending now', 'mirror is outside its time window', at(`${MIRROR}.endTime`, String(NOW))],
  ['a mirror starting more than 5 minutes ahead', 'mirror is outside its time window', at(`${MIRROR}.startTime`, String(NOW + 301))],
  ['no criteria resolver', 'exactly one criteria resolver required', at('criteriaResolvers', [])],
  ['two criteria resolvers', 'exactly one criteria resolver required', edit('criteriaResolvers', list => list.push(structuredClone(list[0]!)))],
  ['criteria resolvers that are not an array', 'exactly one criteria resolver required', at('criteriaResolvers', null)],
  ['a resolver for the mirror', 'unexpected criteria resolver', at('criteriaResolvers.0.orderIndex', 1)],
  ['a resolver on the offer side', 'unexpected criteria resolver', at('criteriaResolvers.0.side', 0)],
  ['a resolver for a payment leg', 'unexpected criteria resolver', at('criteriaResolvers.0.index', 1)],
  ['a resolver for another token', 'unexpected criteria resolver', at('criteriaResolvers.0.identifier', '43')],
  ['a resolver with a proof', 'unexpected criteria resolver', at('criteriaResolvers.0.criteriaProof', [ZERO_BYTES32])],
  ['a resolver without a proof array', 'unexpected criteria resolver', at('criteriaResolvers.0.criteriaProof', undefined)],
  ['no fulfillments', 'unexpected fulfillments', at('fulfillments', null)],
  ['the royalty fulfillment missing', 'unexpected fulfillments', fulfillments(list => list.pop())],
  ['an extra fulfillment', 'unexpected fulfillments', fulfillments(list => list.push(structuredClone(list[3]!)))],
  ['the NFT and seller-net fulfillments swapped', 'unexpected fulfillments', fulfillments(list => list.splice(0, 2, list[1]!, list[0]!))],
  ['the seller net routed into the fee leg', 'unexpected fulfillments', at('fulfillments.1.considerationComponents.0.itemIndex', 1)],
  ['the NFT taken from the bid', 'unexpected fulfillments', at('fulfillments.0.offerComponents.0.orderIndex', 0)],
  ['two offer components in one fulfillment', 'unexpected fulfillments', edit('fulfillments.2.offerComponents', list => list.push({ orderIndex: 0, itemIndex: 0 }))],
  ['the royalty paid into the mirror', 'unexpected fulfillments', at('fulfillments.3.considerationComponents.0.orderIndex', 1)],
  ['proceeds to another wallet', 'recipient must be you', at('recipient', OTHER)],
  ['no recipient', 'recipient must be you', at('recipient', undefined)],
  ['a moved counter', 'order does not hash to this offer', exp({ counter: 1n })],
  ['another bid salt', 'order does not hash to this offer', at(`${BID}.salt`, '1')],
  ['a bid without its royalty leg and a matching quote, mirror and layout', 'order does not hash to this offer', all(
    bidConsideration(list => list.pop()),
    at(`${BID}.totalOriginalConsiderationItems`, 2),
    at('amounts.royaltyWei', '0'),
    at('amounts.sellerNetWei', '990000000000000000'),
    at(`${MIRROR}.consideration.0.startAmount`, '990000000000000000'),
    at(`${MIRROR}.consideration.0.endAmount`, '990000000000000000'),
    fulfillments(list => list.pop()),
  )],
];

describe('accept guard: collection offers (matchAdvancedOrders + unsigned mirror)', () => {
  it.each(collectionCases)('refuses %s', (_name, reason, mutate) => {
    expect(rejection(collectionBase(), mutate)).toBe(guardMessage(reason));
  });
});

interface RequirementsInput {
  chainId: number;
  maker: string;
  items: OfferItemRequest[];
}

interface RequirementsBase {
  requirements: Json;
  input: RequirementsInput;
}

function requirementsBase(): RequirementsBase {
  return {
    requirements: {
      seaport: SEAPORT_ADDRESS,
      conduitKey: ZERO_BYTES32,
      sellerConduitKey: OPENSEA_CONDUIT_KEY,
      currency: { address: WRAPPED_NATIVE[1]!, symbol: 'WETH', decimals: 18 },
      feeRecipient: MAINNET_FEE_RECIPIENT,
      feeBps: 100,
      balanceWei: '0',
      allowanceWei: '0',
      openOffersWei: '0',
      requiredAllowanceWei: ONE.toString(),
      items: [{ contract: COLLECTION, tokenId: '1', kind: 'item', isErc1155: false, blocked: false, reason: null, feeWei: (ONE / 100n).toString(), royaltyRecipient: ROYALTY_RECIPIENT, royaltyWei: (ONE / 20n).toString(), sellerNetWei: (ONE - ONE / 100n - ONE / 20n).toString() }],
    },
    input: { chainId: 1, maker: TEST_ADDRESS, items: [{ kind: 'item', contract: COLLECTION, tokenId: '1', amountWei: ONE, quantity: 1 }] },
  };
}

const asCollection: Mutation<RequirementsInput> = (requirements, input) => {
  input.items[0] = { ...input.items[0]!, kind: 'collection', tokenId: null };
  Object.assign((requirements.items as Json[])[0]!, { kind: 'collection', tokenId: null });
};

function requirementsRejection(mutate: Mutation<RequirementsInput>): string {
  const { requirements, input } = requirementsBase();
  const replaced = mutate(requirements, input);
  try {
    assertOfferRequirements((replaced === undefined ? requirements : replaced) as unknown as OfferRequirements, input);
  } catch (err) {
    expect(err).toBeInstanceOf(OfferRequirementsError);
    return (err as Error).message;
  }
  throw new Error('the guard accepted the mutated requirements');
}

const requirementsCases: Array<Case<RequirementsInput>> = [
  ['an unsupported chain', 'unsupported chain', (_r, input) => {
    input.chainId = 5;
  }],
  ['no requirements', 'missing requirements', () => null],
  ['Seaport 1.5', 'unexpected Seaport address', at('seaport', SEAPORT_15)],
  ['the OpenSea conduit for the bidder', 'unexpected offer conduit key', at('conduitKey', OPENSEA_CONDUIT_KEY)],
  ['no seller conduit', 'unexpected seller conduit key', at('sellerConduitKey', ZERO_BYTES32)],
  ['WAPE on mainnet', 'unexpected currency', at('currency.address', WAPE)],
  ['a 6-decimal currency', 'unexpected currency', at('currency.decimals', 6)],
  ['no currency', 'unexpected currency', at('currency', null)],
  ['the ApeChain fee recipient on mainnet', 'unexpected fee recipient', at('feeRecipient', APE_FEE_RECIPIENT)],
  ['a 0.99% fee', 'unexpected fee', at('feeBps', 99)],
  ['the fee as a string', 'unexpected fee', at('feeBps', '100')],
  ['no items', 'item count mismatch', at('items', [])],
  ['items that are not an array', 'item count mismatch', at('items', null)],
  ['an extra item', 'item count mismatch', edit('items', list => list.push(structuredClone(list[0]!)))],
  ['a blocked item', 'this collection only trades through OpenSea\'s own zone', at('items.0.blocked', true)],
  ['negative open offers', 'invalid open offers', at('openOffersWei', '-1')],
  ['a numeric required allowance', 'invalid required allowance', at('requiredAllowanceWei', 1e18)],
  ['an allowance 1 wei too high', 'required allowance mismatch', at('requiredAllowanceWei', (ONE + 1n).toString())],
  ['an allowance that leaves out the open offers', 'required allowance mismatch', at('openOffersWei', '5')],
  ['an allowance for one unit of two', 'required allowance mismatch', (_r, input) => {
    input.items[0]!.quantity = 2;
  }],
  ['another collection', 'item mismatch', at('items.0.contract', OTHER)],
  ['the collection kind for an item request', 'item mismatch', at('items.0.kind', 'collection')],
  ['another token id', 'item mismatch', at('items.0.tokenId', '2')],
  ['a token id on a collection offer', 'item mismatch', all(asCollection, at('items.0.tokenId', '1'))],
  ['an ERC-1155 collection offer', 'collection offers are ERC-721 only', all(asCollection, at('items.0.isErc1155', true))],
  ['a malformed royalty recipient', 'invalid royalty recipient', at('items.0.royaltyRecipient', 'dead')],
  ['no royalty recipient field', 'invalid royalty recipient', at('items.0.royaltyRecipient', undefined)],
  ['a decimal fee', 'invalid fee', at('items.0.feeWei', '1.5')],
  ['no royalty', 'invalid royalty', at('items.0.royaltyWei', undefined)],
  ['a numeric seller net', 'invalid seller net', at('items.0.sellerNetWei', 94e16)],
  ['a fee 1 wei above 1%', 'fee mismatch', at('items.0.feeWei', (ONE / 100n + 1n).toString())],
  ['a zero fee', 'fee mismatch', at('items.0.feeWei', '0')],
  ['a royalty 1 wei above 25%', 'royalty too high', at('items.0.royaltyWei', (ONE / 4n + 1n).toString())],
  ['a zero offer', 'fee and royalty exceed the offer', all<RequirementsInput>((_r, input) => {
    input.items[0]!.amountWei = 0n;
  }, at('requiredAllowanceWei', '0'), at('items.0.feeWei', '0'), at('items.0.royaltyWei', '0'), at('items.0.sellerNetWei', '0'))],
  ['a seller net 1 wei high', 'seller net mismatch', at('items.0.sellerNetWei', (ONE - ONE / 100n - ONE / 20n + 1n).toString())],
  ['a royalty without a recipient still deducted from the seller net', 'seller net mismatch', at('items.0.royaltyRecipient', null)],
];

describe('offer requirements guard (making an offer)', () => {
  it('passes the unmutated item and collection requirements', () => {
    const { requirements, input } = requirementsBase();
    expect(assertOfferRequirements(requirements as unknown as OfferRequirements, input).items[0]!.sellerNetWeiBig).toBe(ONE - ONE / 100n - ONE / 20n);
    const collection = requirementsBase();
    asCollection(collection.requirements, collection.input);
    expect(() => assertOfferRequirements(collection.requirements as unknown as OfferRequirements, collection.input)).not.toThrow();
  });

  it.each(requirementsCases)('refuses %s', (_name, reason, mutate) => {
    expect(requirementsRejection(mutate)).toBe(new OfferRequirementsError(reason).message);
  });

  it('refuses to read offer funding on an unsupported chain', async () => {
    await expect(readOfferFunding({} as PublicClient, 5, TEST_ADDRESS)).rejects.toThrow('Offers are not supported on this chain');
  });
});

describe('fixture isolation', () => {
  it('no case leaked a mutation into the shared vectors', () => {
    expect(JSON.stringify(offers)).toBe(PRISTINE);
  });
});
