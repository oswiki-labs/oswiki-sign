import { createPublicClient, custom, encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import {
  encodeBasicOrder,
  encodeFulfillAdvancedOrder,
  encodeFulfillAvailableAdvancedOrders,
  encodeMatchAdvancedOrders,
  FULFILL_ADVANCED_ORDER_ABI,
  NFT_ABI,
  SEAPORT_CANCEL_ABI,
  withDomainTag,
  WRAPPED_NATIVE_ABI,
} from '../src/abi.js';
import { assertAllowedTx, TxRefusedError } from '../src/chain.js';
import { OPENSEA_CONDUIT_ADDRESS, OPENSEA_CONDUIT_KEY, SEAPORT_ADDRESS, WRAPPED_NATIVE, ZERO_ADDRESS, ZERO_BYTES32 } from '../src/constants.js';
import { assertOwnListingOrder } from '../src/flows/listing.js';
import { encodeSeaportCancel } from '../src/seaport/cancel.js';
import { assertOswikiSeaportOrder, OswikiOrderGuardError, readAdvancedOrder } from '../src/seaport/fulfill.js';
import {
  assertSeaportRequirements,
  checkRoyaltyCap,
  CounterUnavailableError,
  ListingRequirementsError,
  readSeaportCounter,
} from '../src/seaport/listing.js';
import { assertOfferRequirements, assertOswikiSeaportOffer, OfferGuardError, OfferRequirementsError, type OfferRequirements } from '../src/seaport/offer.js';
import { usableOpenSeaTerms } from '../src/seaport/opensea.js';
import { buildListingOrder } from '../src/seaport/order.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { COLLECTION, listingRequirements, MAINNET_FEE_RECIPIENT, TEST_ADDRESS } from './helpers.js';

const ONE_ETH = 10n ** 18n;

describe('listing requirements guard', () => {
  const ok = () => listingRequirements(1, [{ contract: COLLECTION, tokenId: '1' }]);

  it('accepts our constants', () => {
    expect(() => assertSeaportRequirements(ok(), 1, 1)).not.toThrow();
  });

  it.each([
    ['wrong fee recipient', { feeRecipient: '0x1111111111111111111111111111111111111111' }, /unexpected fee recipient/],
    ['ApeChain fee recipient on mainnet', { feeRecipient: '0x70a5af9ff16b9c436dbe6c1796930f4e1795abc6' }, /unexpected fee recipient/],
    ['wrong conduit', { conduit: '0x2222222222222222222222222222222222222222' }, /unexpected conduit/],
    ['wrong conduit key', { conduitKey: ZERO_BYTES32 }, /unexpected conduit key/],
    ['wrong Seaport', { seaport: '0x00000000000000adc04c56bf30ac9d3c0aaf14dc' }, /unexpected Seaport/],
    ['fee above 100 bps', { feeBps: 101 }, /unexpected fee/],
    ['a discounted fee', { feeBps: 99 }, /unexpected fee/],
    ['a zero fee', { feeBps: 0 }, /unexpected fee/],
  ])('refuses %s', (_name, override, message) => {
    expect(() => assertSeaportRequirements({ ...ok(), ...override } as never, 1, 1)).toThrow(message);
  });

  it('refuses a royalty above 25%', () => {
    const item = { ...ok().items[0]!, royaltyWei: (ONE_ETH / 4n + 1n).toString() };
    expect(() => checkRoyaltyCap(item, ONE_ETH)).toThrow(ListingRequirementsError);
    expect(() => checkRoyaltyCap({ ...item, royaltyWei: (ONE_ETH / 4n).toString() }, ONE_ETH)).not.toThrow();
  });

  it('refuses an OpenSea twin with foreign protocol, conduit or fee recipient', () => {
    const terms = { chain: 'ethereum', protocolAddress: SEAPORT_ADDRESS, conduitKey: OPENSEA_CONDUIT_KEY, zone: '0x0000000000000000000000000000000000000000', orderType: 1, feeRecipient: '0x0000a26b00c1f0df003000390027140000faa719', feeBps: 100, creatorFees: [] };
    expect(usableOpenSeaTerms(terms, 1)).not.toBeNull();
    expect(usableOpenSeaTerms({ ...terms, feeRecipient: '0x1111111111111111111111111111111111111111' }, 1)).toBeNull();
    expect(usableOpenSeaTerms({ ...terms, conduitKey: ZERO_BYTES32 }, 1)).toBeNull();
    expect(usableOpenSeaTerms({ ...terms, creatorFees: [{ recipient: '0x8888888888888888888888888888888888888888', bps: 3500 }] }, 1)).toBeNull();
  });
});

describe('own listing check before signing', () => {
  const order = () => buildListingOrder({ offerer: TEST_ADDRESS, token: COLLECTION, tokenId: '7', isErc1155: false, unitPriceWei: ONE_ETH, feeBps: 100, feeRecipient: MAINNET_FEE_RECIPIENT, royaltyRecipient: '0x000000000000000000000000000000000000dead', royaltyWei: ONE_ETH / 20n, counter: 0n, durationSeconds: 86400 });
  const expected = { chainId: 1, offerer: TEST_ADDRESS, contract: COLLECTION, tokenId: '7', quantity: 1n, unitPriceWei: ONE_ETH };

  it('passes the built order', () => {
    expect(() => assertOwnListingOrder(order(), expected)).not.toThrow();
  });

  it('catches consideration tampering', () => {
    const tampered = order();
    tampered.consideration[0] = { ...tampered.consideration[0]!, recipient: '0x1111111111111111111111111111111111111111' };
    expect(() => assertOwnListingOrder(tampered, expected)).toThrow(/first payment/);
    const cheaper = order();
    cheaper.consideration[0] = { ...cheaper.consideration[0]!, startAmount: 1n, endAmount: 1n };
    expect(() => assertOwnListingOrder(cheaper, expected)).toThrow(/total/);
    const conduit = { ...order(), conduitKey: ZERO_BYTES32 };
    expect(() => assertOwnListingOrder(conduit, expected)).toThrow(/conduit/);
  });

  it('requires the 1% fee leg to the known recipient', () => {
    const noFee = order();
    noFee.consideration = [{ ...noFee.consideration[0]!, startAmount: noFee.consideration[0]!.startAmount + noFee.consideration[1]!.startAmount, endAmount: noFee.consideration[0]!.startAmount + noFee.consideration[1]!.startAmount }, noFee.consideration[2]!];
    expect(() => assertOwnListingOrder(noFee, expected)).toThrow(/fee leg/);
    const redirected = order();
    redirected.consideration[1] = { ...redirected.consideration[1]!, recipient: '0x1111111111111111111111111111111111111111' };
    expect(() => assertOwnListingOrder(redirected, expected)).toThrow(/fee leg/);
  });
});

describe('buy guard', () => {
  const base = () => ({
    to: SEAPORT_ADDRESS,
    value: '1000000000000000000',
    orderData: { parameters: structuredClone(vectors.orders.erc721.parameters), signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' },
  });

  it('refuses a value that is not the exact order total', () => {
    expect(() => assertOswikiSeaportOrder({ ...base(), value: '999999999999999999' })).toThrow(OswikiOrderGuardError);
    expect(() => assertOswikiSeaportOrder({ ...base(), value: '1000000000000000001' })).toThrow(/exact order total/);
  });

  it('refuses another target, a zone, non-native consideration and the wrong NFT', () => {
    expect(() => assertOswikiSeaportOrder({ ...base(), to: '0x1111111111111111111111111111111111111111' })).toThrow(/not Seaport/);
    const zoned = base();
    zoned.orderData.parameters.zone = '0x1111111111111111111111111111111111111111';
    expect(() => assertOswikiSeaportOrder(zoned)).toThrow(/zone/);
    const erc20 = base();
    erc20.orderData.parameters.consideration[1]!.itemType = 1;
    expect(() => assertOswikiSeaportOrder(erc20)).toThrow(/native/);
    expect(() => assertOswikiSeaportOrder(base(), { tokenId: '2' })).toThrow(/expected NFT/);
  });
});

describe('offer requirements guard', () => {
  const requirements = (): OfferRequirements => ({
    seaport: SEAPORT_ADDRESS,
    conduitKey: ZERO_BYTES32,
    sellerConduitKey: OPENSEA_CONDUIT_KEY,
    currency: { address: WRAPPED_NATIVE[1]!, symbol: 'WETH', decimals: 18 },
    feeRecipient: MAINNET_FEE_RECIPIENT,
    feeBps: 100,
    balanceWei: '0',
    allowanceWei: '0',
    openOffersWei: '0',
    requiredAllowanceWei: ONE_ETH.toString(),
    items: [{ contract: COLLECTION, tokenId: '1', kind: 'item', isErc1155: false, blocked: false, reason: null, feeWei: (ONE_ETH / 100n).toString(), royaltyRecipient: '0x000000000000000000000000000000000000dead', royaltyWei: (ONE_ETH / 20n).toString(), sellerNetWei: (ONE_ETH - ONE_ETH / 100n - ONE_ETH / 20n).toString() }],
  });
  const input = { chainId: 1, maker: TEST_ADDRESS, items: [{ kind: 'item' as const, contract: COLLECTION, tokenId: '1', amountWei: ONE_ETH, quantity: 1 }] };

  it('accepts consistent terms and refuses each tampering', () => {
    expect(() => assertOfferRequirements(requirements(), input)).not.toThrow();
    expect(() => assertOfferRequirements({ ...requirements(), feeRecipient: '0x1111111111111111111111111111111111111111' }, input)).toThrow(/fee recipient/);
    expect(() => assertOfferRequirements({ ...requirements(), feeBps: 0 }, input)).toThrow(/unexpected fee/);
    expect(() => assertOfferRequirements({ ...requirements(), conduitKey: OPENSEA_CONDUIT_KEY }, input)).toThrow(OfferRequirementsError);
    expect(() => assertOfferRequirements({ ...requirements(), currency: { address: '0x1111111111111111111111111111111111111111', symbol: 'X', decimals: 18 } }, input)).toThrow(/currency/);
    expect(() => assertOfferRequirements({ ...requirements(), requiredAllowanceWei: maxUint256.toString() }, input)).toThrow(/required allowance/);
    const royalty = requirements();
    royalty.items[0]!.royaltyWei = (ONE_ETH / 3n).toString();
    expect(() => assertOfferRequirements(royalty, input)).toThrow(/royalty too high/);
  });
});

describe('accept guard', () => {
  const vector = vectors.offers.offerErc721;
  const data = () => ({
    bidId: `oswiki-${vector.orderHash}`,
    kind: 'item',
    to: SEAPORT_ADDRESS,
    value: '0',
    method: 'fulfillBasicOrder_efficient_6GL6yc',
    amounts: { offerWei: '1000000000000000000', feeWei: '10000000000000000', royaltyWei: '50000000000000000', sellerNetWei: '940000000000000000' },
    approval: { token: COLLECTION, operator: OPENSEA_CONDUIT_ADDRESS },
    basicOrderParameters: structuredClone(vector.basicOrderParameters) as Record<string, unknown>,
  });
  const expected = { chainId: 1, bidId: `oswiki-${vector.orderHash}`, maker: vectors.signer.address, fulfiller: TEST_ADDRESS, contract: COLLECTION, tokenId: '1', counter: 0n };

  it('refuses an approval to an unknown operator and a payout that does not add up', () => {
    expect(() => assertOswikiSeaportOffer({ ...data(), approval: { token: COLLECTION, operator: '0x1111111111111111111111111111111111111111' } }, expected)).toThrow(OfferGuardError);
    expect(() => assertOswikiSeaportOffer({ ...data(), amounts: { ...data().amounts, sellerNetWei: '950000000000000000' } }, expected)).toThrow(/seller net|fee or royalty/);
  });

  it('refuses a bid that does not hash to the bidId under the live counter', () => {
    expect(() => assertOswikiSeaportOffer(data(), { ...expected, counter: 1n })).toThrow(/does not hash/);
  });
});

describe('counter read', () => {
  it('fails closed instead of defaulting to 0', async () => {
    const client = createPublicClient({ chain: mainnet, transport: custom({ request: async () => { throw new Error('rpc down'); } }) });
    await expect(readSeaportCounter(client as never, TEST_ADDRESS)).rejects.toBeInstanceOf(CounterUnavailableError);
  });
});

describe('transaction allowlist', () => {
  const nft = new Set([COLLECTION]);
  const approval = (operator: string) => encodeFunctionData({ abi: NFT_ABI, functionName: 'setApprovalForAll', args: [operator as `0x${string}`, true] });

  it('allows only the known shapes', () => {
    expect(() => assertAllowedTx({ chainId: 1, to: COLLECTION, data: approval(OPENSEA_CONDUIT_ADDRESS), value: 0n }, nft)).not.toThrow();
    expect(() => assertAllowedTx({ chainId: 1, to: SEAPORT_ADDRESS, data: encodeSeaportCancel([]), value: 0n }, nft)).not.toThrow();
    expect(() => assertAllowedTx({ chainId: 1, to: WRAPPED_NATIVE[1]!, data: encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'approve', args: [SEAPORT_ADDRESS, ONE_ETH] }), value: 0n }, nft)).not.toThrow();
  });

  it('refuses an approval to an unknown operator', () => {
    expect(() => assertAllowedTx({ chainId: 1, to: COLLECTION, data: approval('0x1111111111111111111111111111111111111111'), value: 0n }, nft)).toThrow(/unknown operator/);
  });

  it('refuses a transaction to an unknown target, or to a collection outside the plan', () => {
    expect(() => assertAllowedTx({ chainId: 1, to: '0x1111111111111111111111111111111111111111', data: '0x', value: 1n }, nft)).toThrow(TxRefusedError);
    expect(() => assertAllowedTx({ chainId: 1, to: '0x2222222222222222222222222222222222222222', data: approval(OPENSEA_CONDUIT_ADDRESS), value: 0n }, nft)).toThrow(/unknown target/);
  });

  it('refuses unlimited or foreign WETH approvals, transfers out of the collection and untagged Seaport calls', () => {
    const weth = WRAPPED_NATIVE[1]!;
    expect(() => assertAllowedTx({ chainId: 1, to: weth, data: encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'approve', args: [SEAPORT_ADDRESS, maxUint256] }), value: 0n }, nft)).toThrow(/unlimited/);
    expect(() => assertAllowedTx({ chainId: 1, to: weth, data: encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'approve', args: ['0x1111111111111111111111111111111111111111', 1n] }), value: 0n }, nft)).toThrow(/unknown spender/);
    expect(() => assertAllowedTx({ chainId: 1, to: COLLECTION, data: encodeFunctionData({ abi: NFT_ABI, functionName: 'transferFrom', args: [TEST_ADDRESS, '0x1111111111111111111111111111111111111111', 1n] }), value: 0n }, nft)).toThrow(/not allowed/);
    const untagged = encodeFunctionData({ abi: SEAPORT_CANCEL_ABI, functionName: 'cancel', args: [[]] });
    expect(() => assertAllowedTx({ chainId: 1, to: SEAPORT_ADDRESS, data: untagged, value: 0n }, nft)).toThrow(/tag/);
    expect(() => assertAllowedTx({ chainId: 1, to: SEAPORT_ADDRESS, data: withDomainTag(untagged as Hex), value: 5n }, nft)).toThrow(/must not carry value/);
  });
});

describe('fill recipient check', () => {
  const FOREIGN = '0x1111111111111111111111111111111111111111' as Address;
  const order = readAdvancedOrder({ parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature }, (reason) => {
    throw new Error(reason);
  });
  const seaport = (data: Hex, value = ONE_ETH) => ({ chainId: 1 as const, to: SEAPORT_ADDRESS, data, value });
  const advanced = (conduitKey: Hex, recipient: Address) => withDomainTag(encodeFunctionData({ abi: FULFILL_ADVANCED_ORDER_ABI, functionName: 'fulfillAdvancedOrder', args: [order, [], conduitKey, recipient] }));
  const basic = (fulfillerConduitKey: Hex) => encodeBasicOrder({
    considerationToken: COLLECTION,
    considerationIdentifier: 1n,
    considerationAmount: 1n,
    offerer: FOREIGN,
    zone: ZERO_ADDRESS,
    offerToken: WRAPPED_NATIVE[1]!,
    offerIdentifier: 0n,
    offerAmount: ONE_ETH,
    basicOrderType: 16,
    startTime: 0n,
    endTime: 1n,
    zoneHash: ZERO_BYTES32,
    salt: 0n,
    offererConduitKey: ZERO_BYTES32,
    fulfillerConduitKey,
    totalOriginalAdditionalRecipients: 0n,
    additionalRecipients: [],
    signature: '0x00',
  });

  it('allows buys to this wallet or msg.sender', () => {
    expect(assertAllowedTx(seaport(encodeFulfillAdvancedOrder(order, TEST_ADDRESS)), new Set(), undefined, TEST_ADDRESS)).toEqual({ kind: 'buy', orders: 1 });
    expect(assertAllowedTx(seaport(encodeFulfillAdvancedOrder(order, ZERO_ADDRESS)), new Set(), undefined, TEST_ADDRESS).kind).toBe('buy');
    expect(assertAllowedTx(seaport(encodeFulfillAvailableAdvancedOrders([order, order], TEST_ADDRESS)), new Set(), undefined, TEST_ADDRESS)).toEqual({ kind: 'buy', orders: 2 });
  });

  it('refuses a buy that delivers the NFT to another wallet', () => {
    expect(() => assertAllowedTx(seaport(encodeFulfillAdvancedOrder(order, FOREIGN)), new Set(), undefined, TEST_ADDRESS)).toThrow(/purchased NFT would go to another wallet/);
    expect(() => assertAllowedTx(seaport(encodeFulfillAvailableAdvancedOrders([order, order], FOREIGN)), new Set(), undefined, TEST_ADDRESS)).toThrow(/another wallet/);
  });

  it('refuses a buy through a fulfiller conduit, and any fill without a known wallet', () => {
    expect(() => assertAllowedTx(seaport(advanced(OPENSEA_CONDUIT_KEY, TEST_ADDRESS)), new Set(), undefined, TEST_ADDRESS)).toThrow(/fulfiller conduit/);
    expect(() => assertAllowedTx(seaport(encodeFulfillAdvancedOrder(order, TEST_ADDRESS)), new Set())).toThrow(/without a known wallet/);
  });

  it('checks the accept paths: match proceeds to this wallet, basic orders only through known conduits', () => {
    expect(assertAllowedTx(seaport(encodeMatchAdvancedOrders([order], [], [], TEST_ADDRESS), 0n), new Set(), undefined, TEST_ADDRESS).kind).toBe('accept');
    expect(() => assertAllowedTx(seaport(encodeMatchAdvancedOrders([order], [], [], FOREIGN), 0n), new Set(), undefined, TEST_ADDRESS)).toThrow(/proceeds would go to another wallet/);
    expect(assertAllowedTx(seaport(basic(OPENSEA_CONDUIT_KEY), 0n), new Set(), undefined, TEST_ADDRESS).kind).toBe('accept');
    expect(assertAllowedTx(seaport(basic(ZERO_BYTES32), 0n), new Set(), undefined, TEST_ADDRESS).kind).toBe('accept');
    expect(() => assertAllowedTx(seaport(basic(`0x${'ab'.repeat(32)}`), 0n), new Set(), undefined, TEST_ADDRESS)).toThrow(/unknown fulfiller conduit/);
  });
});
