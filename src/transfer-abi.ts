export const ERC721_SAFE_TRANSFER_ABI = [
  { name: 'safeTransferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
] as const;

export const ERC1155_TRANSFER_ABI = [
  { name: 'safeTransferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
  { name: 'safeBatchTransferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'ids', type: 'uint256[]' }, { name: 'amounts', type: 'uint256[]' }, { name: 'data', type: 'bytes' }], outputs: [] },
] as const;

export const NFT_TRANSFER_ABI = [...ERC721_SAFE_TRANSFER_ABI, ...ERC1155_TRANSFER_ABI] as const;

export const WRAPPED_TRANSFER_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
] as const;

export const ENS_REGISTRY_ADDRESS = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e' as const;

export const ENS_REGISTRY_ABI = [
  { name: 'resolver', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
] as const;

export const ENS_RESOLVER_ABI = [
  { name: 'addr', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'string' }] },
] as const;

export const ENS_ADDR_COIN_ABI = [
  { name: 'addr', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }], outputs: [{ name: '', type: 'bytes' }] },
] as const;
