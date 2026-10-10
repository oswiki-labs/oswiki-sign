import { encodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem';

import { ZERO_BYTES32 } from './constants.js';

/** bytes4(keccak256("oswiki.xyz")): Seaport ignores trailing calldata, indexers read it as the fill's marketplace. */
export const OSWIKI_DOMAIN_TAG = '0xda32920a';

export function withDomainTag(data: Hex): Hex {
  return `${data}${OSWIKI_DOMAIN_TAG.slice(2)}`;
}

export const FULFILL_BASIC_ORDER_ABI = [{
  name: 'fulfillBasicOrder_efficient_6GL6yc',
  type: 'function',
  stateMutability: 'payable',
  inputs: [{
    name: 'parameters',
    type: 'tuple',
    components: [
      { name: 'considerationToken', type: 'address' },
      { name: 'considerationIdentifier', type: 'uint256' },
      { name: 'considerationAmount', type: 'uint256' },
      { name: 'offerer', type: 'address' },
      { name: 'zone', type: 'address' },
      { name: 'offerToken', type: 'address' },
      { name: 'offerIdentifier', type: 'uint256' },
      { name: 'offerAmount', type: 'uint256' },
      { name: 'basicOrderType', type: 'uint8' },
      { name: 'startTime', type: 'uint256' },
      { name: 'endTime', type: 'uint256' },
      { name: 'zoneHash', type: 'bytes32' },
      { name: 'salt', type: 'uint256' },
      { name: 'offererConduitKey', type: 'bytes32' },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'totalOriginalAdditionalRecipients', type: 'uint256' },
      { name: 'additionalRecipients', type: 'tuple[]', components: [
        { name: 'amount', type: 'uint256' },
        { name: 'recipient', type: 'address' },
      ] },
      { name: 'signature', type: 'bytes' },
    ],
  }],
  outputs: [{ name: 'fulfilled', type: 'bool' }],
}] as const;

const OFFER_ITEM_COMPONENTS = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
] as const;

const CONSIDERATION_ITEM_COMPONENTS = [
  ...OFFER_ITEM_COMPONENTS,
  { name: 'recipient', type: 'address' },
] as const;

const ORDER_PARAMETERS_COMPONENTS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  { name: 'offer', type: 'tuple[]', components: OFFER_ITEM_COMPONENTS },
  { name: 'consideration', type: 'tuple[]', components: CONSIDERATION_ITEM_COMPONENTS },
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'totalOriginalConsiderationItems', type: 'uint256' },
] as const;

const ORDER_COMPONENTS_COMPONENTS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  { name: 'offer', type: 'tuple[]', components: OFFER_ITEM_COMPONENTS },
  { name: 'consideration', type: 'tuple[]', components: CONSIDERATION_ITEM_COMPONENTS },
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'counter', type: 'uint256' },
] as const;

const CRITERIA_RESOLVER_COMPONENTS = [
  { name: 'orderIndex', type: 'uint256' },
  { name: 'side', type: 'uint8' },
  { name: 'index', type: 'uint256' },
  { name: 'identifier', type: 'uint256' },
  { name: 'criteriaProof', type: 'bytes32[]' },
] as const;

const ADVANCED_ORDER_COMPONENTS = [
  { name: 'parameters', type: 'tuple', components: ORDER_PARAMETERS_COMPONENTS },
  { name: 'numerator', type: 'uint120' },
  { name: 'denominator', type: 'uint120' },
  { name: 'signature', type: 'bytes' },
  { name: 'extraData', type: 'bytes' },
] as const;

const FULFILLMENT_COMPONENT_COMPONENTS = [
  { name: 'orderIndex', type: 'uint256' },
  { name: 'itemIndex', type: 'uint256' },
] as const;

const EXECUTION_COMPONENTS = [
  { name: 'item', type: 'tuple', components: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifier', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ] },
  { name: 'offerer', type: 'address' },
  { name: 'conduitKey', type: 'bytes32' },
] as const;

export const FULFILL_ADVANCED_ORDER_ABI = [{
  name: 'fulfillAdvancedOrder',
  type: 'function',
  stateMutability: 'payable',
  inputs: [
    { name: 'advancedOrder', type: 'tuple', components: ADVANCED_ORDER_COMPONENTS },
    { name: 'criteriaResolvers', type: 'tuple[]', components: CRITERIA_RESOLVER_COMPONENTS },
    { name: 'fulfillerConduitKey', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
  ],
  outputs: [{ name: 'fulfilled', type: 'bool' }],
}] as const;

export const FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI = [{
  name: 'fulfillAvailableAdvancedOrders',
  type: 'function',
  stateMutability: 'payable',
  inputs: [
    { name: 'advancedOrders', type: 'tuple[]', components: ADVANCED_ORDER_COMPONENTS },
    { name: 'criteriaResolvers', type: 'tuple[]', components: CRITERIA_RESOLVER_COMPONENTS },
    { name: 'offerFulfillments', type: 'tuple[][]', components: FULFILLMENT_COMPONENT_COMPONENTS },
    { name: 'considerationFulfillments', type: 'tuple[][]', components: FULFILLMENT_COMPONENT_COMPONENTS },
    { name: 'fulfillerConduitKey', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'maximumFulfilled', type: 'uint256' },
  ],
  outputs: [
    { name: 'availableOrders', type: 'bool[]' },
    { name: 'executions', type: 'tuple[]', components: EXECUTION_COMPONENTS },
  ],
}] as const;

export const MATCH_ADVANCED_ORDERS_ABI = [{
  name: 'matchAdvancedOrders',
  type: 'function',
  stateMutability: 'payable',
  inputs: [
    { name: 'orders', type: 'tuple[]', components: ADVANCED_ORDER_COMPONENTS },
    { name: 'criteriaResolvers', type: 'tuple[]', components: CRITERIA_RESOLVER_COMPONENTS },
    { name: 'fulfillments', type: 'tuple[]', components: [
      { name: 'offerComponents', type: 'tuple[]', components: FULFILLMENT_COMPONENT_COMPONENTS },
      { name: 'considerationComponents', type: 'tuple[]', components: FULFILLMENT_COMPONENT_COMPONENTS },
    ] },
    { name: 'recipient', type: 'address' },
  ],
  outputs: [{ name: 'executions', type: 'tuple[]', components: EXECUTION_COMPONENTS }],
}] as const;

export const SEAPORT_GET_COUNTER_ABI = [{
  name: 'getCounter',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'offerer', type: 'address' }],
  outputs: [{ name: 'counter', type: 'uint256' }],
}] as const;

export const SEAPORT_GET_ORDER_STATUS_ABI = [{
  name: 'getOrderStatus',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'orderHash', type: 'bytes32' }],
  outputs: [
    { name: 'isValidated', type: 'bool' },
    { name: 'isCancelled', type: 'bool' },
    { name: 'totalFilled', type: 'uint256' },
    { name: 'totalSize', type: 'uint256' },
  ],
}] as const;

export const SEAPORT_CANCEL_ABI = [{
  name: 'cancel',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'orders', type: 'tuple[]', components: ORDER_COMPONENTS_COMPONENTS }],
  outputs: [{ name: 'cancelled', type: 'bool' }],
}] as const;

export const SEAPORT_EVENTS_ABI = [
  {
    type: 'event',
    name: 'OrderFulfilled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: false },
      { name: 'offerer', type: 'address', indexed: true },
      { name: 'zone', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: false },
      { name: 'offer', type: 'tuple[]', indexed: false, components: [
        { name: 'itemType', type: 'uint8' },
        { name: 'token', type: 'address' },
        { name: 'identifier', type: 'uint256' },
        { name: 'amount', type: 'uint256' },
      ] },
      { name: 'consideration', type: 'tuple[]', indexed: false, components: [
        { name: 'itemType', type: 'uint8' },
        { name: 'token', type: 'address' },
        { name: 'identifier', type: 'uint256' },
        { name: 'amount', type: 'uint256' },
        { name: 'recipient', type: 'address' },
      ] },
    ],
  },
  {
    type: 'event',
    name: 'OrderCancelled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: false },
      { name: 'offerer', type: 'address', indexed: true },
      { name: 'zone', type: 'address', indexed: true },
    ],
  },
] as const;

const SEAPORT_ERROR_SIGNATURES = [
  'BadContractSignature()',
  'BadFraction()',
  'BadReturnValueFromERC20OnTransfer(address,address,address,uint256)',
  'BadSignatureV(uint8)',
  'CannotCancelOrder()',
  'ChannelClosed(address)',
  'ConsiderationNotMet(uint256,uint256,uint256)',
  'InexactFraction()',
  'InsufficientNativeTokensSupplied()',
  'InvalidCallToConduit(address)',
  'InvalidCanceller()',
  'InvalidConduit(bytes32,address)',
  'InvalidMsgValue(uint256)',
  'InvalidProof()',
  'InvalidSignature()',
  'InvalidSigner()',
  'InvalidTime(uint256,uint256)',
  'NoContract(address)',
  'NoSpecifiedOrdersAvailable()',
  'OrderAlreadyFilled(bytes32)',
  'OrderIsCancelled(bytes32)',
  'OrderPartiallyFilled(bytes32)',
  'TokenTransferGenericFailure(address,address,address,uint256,uint256)',
  'CreatorTokenTransferValidator__CallerMustBeWhitelisted()',
  'CreatorTokenTransferValidator__CallerOrFromMustBeWhitelisted()',
  'CreatorTokenTransferValidator__TokenIsSoulbound()',
  'ValidatorCallFailed()',
] as const;

export const SEAPORT_ERROR_SELECTORS: Readonly<Record<string, string>> = Object.fromEntries(
  SEAPORT_ERROR_SIGNATURES.map(signature => [toFunctionSelector(signature), signature.slice(0, signature.indexOf('('))]),
);

export const CONDUIT_RESTRICTION_ERRORS = new Set([
  'CreatorTokenTransferValidator__CallerMustBeWhitelisted',
  'CreatorTokenTransferValidator__CallerOrFromMustBeWhitelisted',
  'CreatorTokenTransferValidator__TokenIsSoulbound',
  'ValidatorCallFailed',
]);

export const WRAPPED_NATIVE_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

export const NFT_ABI = [
  { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'isApprovedForAll', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'setApprovalForAll', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { name: 'supportsInterface', type: 'function', stateMutability: 'view', inputs: [{ name: 'interfaceId', type: 'bytes4' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'transferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { name: 'safeTransferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
] as const;

export const ERC1271_ABI = [{
  name: 'isValidSignature',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }],
  outputs: [{ name: 'magicValue', type: 'bytes4' }],
}] as const;

export const ERC1271_MAGIC_VALUE = '0x1626ba7e' as const;
export const ERC1155_INTERFACE_ID = '0xd9b67a26' as const;

export interface SeaportAdvancedOrder {
  parameters: {
    offerer: Address;
    zone: Address;
    offer: Array<{ itemType: number; token: Address; identifierOrCriteria: bigint; startAmount: bigint; endAmount: bigint }>;
    consideration: Array<{ itemType: number; token: Address; identifierOrCriteria: bigint; startAmount: bigint; endAmount: bigint; recipient: Address }>;
    orderType: number;
    startTime: bigint;
    endTime: bigint;
    zoneHash: Hex;
    salt: bigint;
    conduitKey: Hex;
    totalOriginalConsiderationItems: bigint;
  };
  numerator: bigint;
  denominator: bigint;
  signature: Hex;
  extraData: Hex;
}

export interface SeaportFulfillmentComponent {
  orderIndex: bigint;
  itemIndex: bigint;
}

export interface SeaportFulfillment {
  offerComponents: SeaportFulfillmentComponent[];
  considerationComponents: SeaportFulfillmentComponent[];
}

export interface SeaportCriteriaResolver {
  orderIndex: bigint;
  side: number;
  index: bigint;
  identifier: bigint;
  criteriaProof: Hex[];
}

export interface BasicOrderParameters {
  considerationToken: Address;
  considerationIdentifier: bigint;
  considerationAmount: bigint;
  offerer: Address;
  zone: Address;
  offerToken: Address;
  offerIdentifier: bigint;
  offerAmount: bigint;
  basicOrderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  offererConduitKey: Hex;
  fulfillerConduitKey: Hex;
  totalOriginalAdditionalRecipients: bigint;
  additionalRecipients: Array<{ amount: bigint; recipient: Address }>;
  signature: Hex;
}

export function encodeBasicOrder(params: BasicOrderParameters): Hex {
  return withDomainTag(encodeFunctionData({ abi: FULFILL_BASIC_ORDER_ABI, functionName: 'fulfillBasicOrder_efficient_6GL6yc', args: [params] }));
}

/** recipient != address(0) delivers the NFT there instead of msg.sender. */
export function encodeFulfillAdvancedOrder(order: SeaportAdvancedOrder, recipient: Address): Hex {
  return withDomainTag(encodeFunctionData({ abi: FULFILL_ADVANCED_ORDER_ABI, functionName: 'fulfillAdvancedOrder', args: [order, [], ZERO_BYTES32, recipient] }));
}

/** One consideration fulfillment per item so every fee recipient is paid; each order offers exactly one item. */
export function encodeFulfillAvailableAdvancedOrders(orders: SeaportAdvancedOrder[], recipient: Address): Hex {
  const offerFulfillments = orders.map((_, i) => [{ orderIndex: BigInt(i), itemIndex: 0n }]);
  const considerationFulfillments: Array<Array<{ orderIndex: bigint; itemIndex: bigint }>> = [];
  orders.forEach((order, oi) => {
    order.parameters.consideration.forEach((_, ci) => {
      considerationFulfillments.push([{ orderIndex: BigInt(oi), itemIndex: BigInt(ci) }]);
    });
  });
  return withDomainTag(encodeFunctionData({
    abi: FULFILL_AVAILABLE_ADVANCED_ORDERS_ABI,
    functionName: 'fulfillAvailableAdvancedOrders',
    args: [orders, [], offerFulfillments, considerationFulfillments, ZERO_BYTES32, recipient, BigInt(orders.length)],
  }));
}

export function encodeMatchAdvancedOrders(
  orders: SeaportAdvancedOrder[],
  criteriaResolvers: SeaportCriteriaResolver[],
  fulfillments: SeaportFulfillment[],
  recipient: Address,
): Hex {
  return withDomainTag(encodeFunctionData({ abi: MATCH_ADVANCED_ORDERS_ABI, functionName: 'matchAdvancedOrders', args: [orders, criteriaResolvers, fulfillments, recipient] }));
}
