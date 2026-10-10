import type { Address, Hex } from 'viem';

export const SEAPORT_ADDRESS = '0x0000000000000068f116a894984e2db1123eb395' as const;
export const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000' as const;
export const OPENSEA_CONDUIT_ADDRESS = '0x1e0049783f008a0085193e00003d00cd54003c71' as const;
export const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1f0df003000390027140000faa719' as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

export const MAINNET_ID = 1;
export const APECHAIN_ID = 33139;
export const SUPPORTED_CHAINS = [MAINNET_ID, APECHAIN_ID] as const;
export type SupportedChainId = typeof SUPPORTED_CHAINS[number];

export const WRAPPED_NATIVE: Record<number, Address> = {
  [MAINNET_ID]: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  [APECHAIN_ID]: '0x48b62137edfa95a428d35c09e44256a739f6b557',
};

export const NATIVE_SYMBOL: Record<number, string> = { [MAINNET_ID]: 'ETH', [APECHAIN_ID]: 'APE' };
export const WRAPPED_SYMBOL: Record<number, string> = { [MAINNET_ID]: 'WETH', [APECHAIN_ID]: 'WAPE' };

export const OSWIKI_FEE_BPS = 100;
export const APECHAIN_MIN_FEE_BPS = 100;
export const OSWIKI_FEE_RECIPIENT = '0x3a1d5441892ea68e7b0dc79ed849a0f5db0b1504';
export const OSWIKI_FEE_RECIPIENT_APECHAIN = '0x70A5Af9ff16b9C436dBe6C1796930F4e1795abC6';

export function getOswikiFeeRecipient(chainId: number): string {
  return chainId === APECHAIN_ID ? OSWIKI_FEE_RECIPIENT_APECHAIN : OSWIKI_FEE_RECIPIENT;
}

export function isSupportedChain(chainId: unknown): chainId is SupportedChainId {
  return chainId === MAINNET_ID || chainId === APECHAIN_ID;
}

export const DEFAULT_RPC: Record<SupportedChainId, string> = {
  [MAINNET_ID]: 'https://ethereum-rpc.publicnode.com',
  [APECHAIN_ID]: 'https://rpc.apechain.com/http',
};

export const API_BASE = 'https://api.oswiki.xyz';
