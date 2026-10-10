import { formatUnits } from 'viem';

import { WRAPPED_NATIVE_ABI } from '../abi.js';
import type { ConfirmMode } from '../config.js';
import { APECHAIN_ID, MAINNET_ID, NATIVE_SYMBOL, SUPPORTED_CHAINS, WRAPPED_NATIVE, type SupportedChainId } from '../constants.js';
import { native, wrapped } from '../format.js';
import { chainOf, type Ctx } from './common.js';

const CHAIN_NAME: Record<SupportedChainId, string> = { [MAINNET_ID]: 'Ethereum', [APECHAIN_ID]: 'ApeChain' };

export async function walletStatus(ctx: Ctx, options: { dialog?: boolean } = {}): Promise<string> {
  const address = ctx.account.address;
  const balances = await Promise.all(SUPPORTED_CHAINS.map(async (chainId) => {
    const client = ctx.chains.client(chainId);
    try {
      const [nativeBalance, wrappedBalance] = await Promise.all([
        client.getBalance({ address }),
        client.readContract({ address: WRAPPED_NATIVE[chainId]!, abi: WRAPPED_NATIVE_ABI, functionName: 'balanceOf', args: [address] }),
      ]);
      return `- ${CHAIN_NAME[chainId]}: ${native(nativeBalance, chainId)}, ${wrapped(wrappedBalance, chainId)}`;
    } catch {
      return `- ${CHAIN_NAME[chainId]}: balance unavailable (RPC error)`;
    }
  }));
  const { config } = ctx;
  const cap = (chainId: SupportedChainId) => {
    const value = config.maxBuyWei[chainId];
    return value === null ? 'NOT SET, buys and offers off' : native(value, chainId);
  };
  const daily = (chainId: SupportedChainId) => {
    const value = config.dailyMaxWei[chainId];
    return value === null ? 'NOT SET' : `${native(ctx.state.spentToday(chainId), chainId)} of ${native(value, chainId)} used`;
  };
  const pending = ctx.state.pendingTxs();
  return [
    `Wallet ${address.toLowerCase()}`,
    ...balances,
    'Limits:',
    `- max per buy/offer: ${cap(MAINNET_ID)} on Ethereum (OSWIKI_MAX_BUY_ETH), ${cap(APECHAIN_ID)} on ApeChain (OSWIKI_MAX_BUY_${NATIVE_SYMBOL[APECHAIN_ID]})`,
    `- listings and accepted offers must be at least ${config.minListFloorPct}% of the floor (OSWIKI_MIN_LIST_FLOOR_PCT)`,
    `- trades today: ${ctx.state.tradesToday()} of ${config.maxTradesPerDay} (OSWIKI_MAX_TRADES_PER_DAY; each item counts)`,
    `- cancels today: ${ctx.state.cancelsToday()} of ${config.maxCancelsPerDay} (OSWIKI_MAX_CANCELS_PER_DAY)`,
    `- spent today on buys and new offers: ${daily(MAINNET_ID)} on Ethereum (OSWIKI_DAILY_MAX_ETH), ${daily(APECHAIN_ID)} on ApeChain (OSWIKI_DAILY_MAX_APE)`,
    '- the daily counts are kept only on this computer, in the state files in OSWIKI_SIGN_STATE_DIR (default ~/.oswiki-sign); deleting those files resets them. They stop mistakes and a misbehaving AI, not someone with access to this computer.',
    `- max network fee: ${formatUnits(config.maxFeePerGasWei[MAINNET_ID], 9)} gwei on Ethereum (OSWIKI_MAX_GWEI), ${formatUnits(config.maxFeePerGasWei[APECHAIN_ID], 9)} gwei on ApeChain (OSWIKI_MAX_GWEI_APECHAIN)`,
    ctx.state.isTampered() ? '- STATE FILE FAILED ITS INTEGRITY CHECK: every daily limit counts as used. Delete ~/.oswiki-sign/state.json only if the wallet key changed.' : '',
    pending.length > 0 ? `- pending transactions: ${pending.map(entry => `${entry.label} ${entry.hash} (${CHAIN_NAME[entry.chainId]})`).join(', ')}` : '',
    `- collections: ${config.allowedCollections ? [...config.allowedCollections].join(', ') : 'any (OSWIKI_ALLOWED_COLLECTIONS not set)'}`,
    `- dry run: ${config.dryRun ? 'ON (nothing is ever signed or sent)' : 'off'}`,
    `- confirmation: ${confirmLine(config.confirmMode, options.dialog)}`,
  ].filter(Boolean).join('\n');
}

function confirmLine(mode: ConfirmMode, dialog: boolean | undefined): string {
  if (dialog === true) return 'the user approves every execute in the oswiki-sign dialog';
  if (mode === 'ai') return 'WARNING - OSWIKI_CONFIRM_MODE=ai: without a dialog, execute runs on the word of the AI alone';
  if (dialog === false) return 'this MCP client cannot show the confirmation dialog, so execute is refused (OSWIKI_CONFIRM_MODE=human)';
  return 'human (execute needs the confirmation dialog of the MCP client)';
}

function chainsFor(chainId: number | undefined): SupportedChainId[] {
  return chainId === undefined ? [...SUPPORTED_CHAINS] : [chainOf(chainId)];
}

export async function myListings(ctx: Ctx, input: { chainId?: number }): Promise<string> {
  const maker = ctx.account.address.toLowerCase();
  const rows = await Promise.all(chainsFor(input.chainId).map(async chainId => ({ chainId, rows: await ctx.api.makerListings(chainId, maker) })));
  const lines = rows.flatMap(({ chainId, rows: listings }) => listings.map(row => `- [${CHAIN_NAME[chainId]}] ${row.id}: ${row.contract} #${row.tokenId ?? '?'} at ${row.price ?? '?'} ${NATIVE_SYMBOL[chainId]}`));
  return lines.length === 0 ? `No active OSWiki listings for ${maker}.` : [`Active OSWiki listings of ${maker}:`, ...lines].join('\n');
}

export async function myOffers(ctx: Ctx, input: { chainId?: number }): Promise<string> {
  const maker = ctx.account.address.toLowerCase();
  const rows = await Promise.all(chainsFor(input.chainId).map(async chainId => ({ chainId, rows: await ctx.api.makerBids(chainId, maker) })));
  const lines = rows.flatMap(({ chainId, rows: bids }) => bids.map(row => `- [${CHAIN_NAME[chainId]}] ${row.id}: ${row.kind || 'offer'} on ${row.contract}${row.tokenId ? ` #${row.tokenId}` : ''} at ${row.price ?? '?'}`));
  return lines.length === 0 ? `No active OSWiki offers for ${maker}.` : [`Active OSWiki offers of ${maker}:`, ...lines].join('\n');
}
