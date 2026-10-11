import { homedir } from 'node:os';

import { formatUnits } from 'viem';

import { WRAPPED_NATIVE_ABI } from '../abi.js';
import type { Config, ConfirmMode } from '../config.js';
import { APECHAIN_ID, MAINNET_ID, NATIVE_SYMBOL, SUPPORTED_CHAINS, WRAPPED_NATIVE, type SupportedChainId } from '../constants.js';
import { CONFIRM_OFF_WARNING, native, wrapped } from '../format.js';
import { DENY_RULES, missingDenyRules, PACKAGE_NAME } from '../setup.js';
import { cachedUpdate, updateNotice } from '../update-check.js';
import { VERSION } from '../version.js';
import { chainOf, type Ctx } from './common.js';

const CHAIN_NAME: Record<SupportedChainId, string> = { [MAINNET_ID]: 'Ethereum', [APECHAIN_ID]: 'ApeChain' };

export async function walletStatus(ctx: Ctx, options: { dialog?: boolean; overrides?: Record<string, string>; settingsWarning?: string | null; claudeCode?: boolean; home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
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
  const sent = (chainId: SupportedChainId) => {
    const value = config.dailyMaxSendWei[chainId];
    const variable = `OSWIKI_DAILY_MAX_SEND_${NATIVE_SYMBOL[chainId]}`;
    return value === null
      ? `- ${CHAIN_NAME[chainId]} fund sending: off (set a daily send limit to enable, ${variable})`
      : `- sent today (native + wrapped) on ${CHAIN_NAME[chainId]}: ${native(ctx.state.sentToday(chainId), chainId)} of ${native(value, chainId)} used (${variable})`;
  };
  const selling = (chainId: SupportedChainId) => {
    const symbol = NATIVE_SYMBOL[chainId];
    const below = config.dailyMaxBelowFloorWei[chainId];
    const sell = config.dailyMaxSellWei[chainId];
    const belowText = below === 0n
      ? `below the floor: off (OSWIKI_DAILY_MAX_BELOW_FLOOR_${symbol} is 0)`
      : `given up below the floor ${native(ctx.state.belowFloorToday(chainId), chainId)} of ${native(below, chainId)} used (OSWIKI_DAILY_MAX_BELOW_FLOOR_${symbol})`;
    const sellText = sell === null
      ? `value sold: no daily cap (OSWIKI_DAILY_MAX_SELL_${symbol})`
      : `value sold ${native(ctx.state.soldToday(chainId), chainId)} of ${native(sell, chainId)} used (OSWIKI_DAILY_MAX_SELL_${symbol})`;
    return `- listings and accepted offers today on ${CHAIN_NAME[chainId]}: ${belowText}; ${sellText}`;
  };
  const pending = ctx.state.pendingTxs();
  const latest = cachedUpdate({ stateDir: config.stateDir, version: VERSION, env: options.env ?? process.env });
  return [
    `Wallet ${address.toLowerCase()}`,
    ...balances,
    latest ? updateNotice(latest, VERSION) : '',
    config.confirmMode === 'off' ? CONFIRM_OFF_WARNING : '',
    config.confirmMode === 'off' && options.claudeCode ? denyRulesWarning(options.home ?? homedir()) : '',
    'Limits:',
    `- max per buy/offer: ${cap(MAINNET_ID)} on Ethereum (OSWIKI_MAX_BUY_ETH), ${cap(APECHAIN_ID)} on ApeChain (OSWIKI_MAX_BUY_${NATIVE_SYMBOL[APECHAIN_ID]})`,
    `- listings and accepted offers must be at least ${config.minListFloorPct}% of the floor (OSWIKI_MIN_LIST_FLOOR_PCT)`,
    `- trades today: ${ctx.state.tradesToday()} of ${config.maxTradesPerDay} (OSWIKI_MAX_TRADES_PER_DAY; each item counts)`,
    `- cancels today: ${ctx.state.cancelsToday()} of ${config.maxCancelsPerDay} (OSWIKI_MAX_CANCELS_PER_DAY)`,
    `- spent today on buys and new offers: ${daily(MAINNET_ID)} on Ethereum (OSWIKI_DAILY_MAX_ETH), ${daily(APECHAIN_ID)} on ApeChain (OSWIKI_DAILY_MAX_APE)`,
    selling(MAINNET_ID),
    selling(APECHAIN_ID),
    sent(MAINNET_ID),
    sent(APECHAIN_ID),
    '- sending NFTs works without a send limit; every send always needs the dialog and every sent NFT counts as a trade',
    '- the daily counts are kept only on this computer, in the state files in OSWIKI_SIGN_STATE_DIR (default ~/.oswiki-sign); deleting those files resets them. They stop mistakes and a misbehaving AI, not someone with access to this computer.',
    `- max network fee: ${formatUnits(config.maxFeePerGasWei[MAINNET_ID], 9)} gwei on Ethereum (OSWIKI_MAX_GWEI), ${formatUnits(config.maxFeePerGasWei[APECHAIN_ID], 9)} gwei on ApeChain (OSWIKI_MAX_GWEI_APECHAIN)`,
    ctx.state.isTampered() ? '- STATE FILE FAILED ITS INTEGRITY CHECK: every daily limit counts as used. Delete ~/.oswiki-sign/state.json only if the wallet key changed.' : '',
    pending.length > 0 ? `- pending transactions: ${pending.map(entry => `${entry.label} ${entry.hash} (${CHAIN_NAME[entry.chainId]})`).join(', ')}` : '',
    `- collections: ${collectionsLine(config)}`,
    `- dry run: ${config.dryRun ? 'ON (nothing is ever signed or sent)' : 'off'}`,
    `- confirmation: ${confirmLine(config.confirmMode, options.dialog)}`,
    options.settingsWarning ?? '',
    ...settingsHelp(config, new Set(Object.keys(options.overrides ?? {}))),
  ].filter(Boolean).join('\n');
}

function denyRulesWarning(home: string): string {
  const missing = missingDenyRules(home);
  if (missing === null || missing.length === 0) return '';
  return `WARNING: confirmation is off and ${missing.length} of the ${DENY_RULES.length} oswiki-sign deny rules are missing from ~/.claude/settings.json, so the agent could read the key file or change its own limits. Run \`npx -y ${PACKAGE_NAME} setup\` again in your own terminal (it adds them) or see the README, Claude Code hardening.`;
}

function collectionsLine(config: Config): string {
  const allowed = config.allowedCollections ? `only ${[...config.allowedCollections].join(', ')} (OSWIKI_ALLOWED_COLLECTIONS)` : '';
  const blocked = config.blockedCollections ? `never ${[...config.blockedCollections].join(', ')} (OSWIKI_BLOCKED_COLLECTIONS; cancelling still works)` : '';
  return [allowed, blocked].filter(Boolean).join('; ') || 'any (OSWIKI_ALLOWED_COLLECTIONS and OSWIKI_BLOCKED_COLLECTIONS not set)';
}

/** Effective value of every setting, by env name, as wallet_status and the update_limits dialog show it. */
export function settingValues(config: Config): Array<[string, string]> {
  const amount = (wei: bigint | null, unset: string) => (wei === null ? `not set (${unset})` : formatUnits(wei, 18));
  const gwei = (wei: bigint) => formatUnits(wei, 9);
  return [
    ['OSWIKI_DRY_RUN', config.dryRun ? '1' : '0'],
    ['OSWIKI_CONFIRM_MODE', config.confirmMode],
    ['OSWIKI_MAX_BUY_ETH', amount(config.maxBuyWei[MAINNET_ID], 'buys and offers off on Ethereum')],
    ['OSWIKI_MAX_BUY_APE', amount(config.maxBuyWei[APECHAIN_ID], 'buys and offers off on ApeChain')],
    ['OSWIKI_DAILY_MAX_ETH', amount(config.dailyMaxWei[MAINNET_ID], 'no daily cap')],
    ['OSWIKI_DAILY_MAX_APE', amount(config.dailyMaxWei[APECHAIN_ID], 'no daily cap')],
    ['OSWIKI_DAILY_MAX_SEND_ETH', amount(config.dailyMaxSendWei[MAINNET_ID], 'fund sending off on Ethereum')],
    ['OSWIKI_DAILY_MAX_SEND_APE', amount(config.dailyMaxSendWei[APECHAIN_ID], 'fund sending off on ApeChain')],
    ['OSWIKI_DAILY_MAX_SELL_ETH', amount(config.dailyMaxSellWei[MAINNET_ID], 'no daily sell cap')],
    ['OSWIKI_DAILY_MAX_SELL_APE', amount(config.dailyMaxSellWei[APECHAIN_ID], 'no daily sell cap')],
    ['OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH', formatUnits(config.dailyMaxBelowFloorWei[MAINNET_ID], 18)],
    ['OSWIKI_DAILY_MAX_BELOW_FLOOR_APE', formatUnits(config.dailyMaxBelowFloorWei[APECHAIN_ID], 18)],
    ['OSWIKI_MIN_LIST_FLOOR_PCT', String(config.minListFloorPct)],
    ['OSWIKI_MAX_TRADES_PER_DAY', String(config.maxTradesPerDay)],
    ['OSWIKI_MAX_CANCELS_PER_DAY', String(config.maxCancelsPerDay)],
    ['OSWIKI_MAX_GWEI', gwei(config.maxFeePerGasWei[MAINNET_ID])],
    ['OSWIKI_MAX_GWEI_APECHAIN', gwei(config.maxFeePerGasWei[APECHAIN_ID])],
    ['OSWIKI_ALLOWED_COLLECTIONS', config.allowedCollections ? [...config.allowedCollections].join(',') : 'not set (any collection)'],
    ['OSWIKI_BLOCKED_COLLECTIONS', config.blockedCollections ? [...config.blockedCollections].join(',') : 'not set (none blocked)'],
    ['OSWIKI_TRUSTED_COLLECTIONS', config.trustedCollections ? [...config.trustedCollections].join(',') : 'not set (autonomous mode trades verified collections only)'],
  ];
}

function settingsHelp(config: Config, fromChat: ReadonlySet<string>): string[] {
  return [
    'Settings in force (exact names and values; source: setup/env, or chat when changed with update_limits):',
    ...settingValues(config).map(([key, value]) => `- ${key}=${value} (${fromChat.has(key) ? 'chat' : 'setup/env'})`),
    `To change limits or confirmation: run \`npx -y ${PACKAGE_NAME} setup\` again in your own terminal (keep the wallet), then restart the AI client.`,
    'Or ask here: update_limits changes them right away, after the user approves the change in oswiki-sign\'s own dialog (or its browser approval page; with neither, use setup). Gas caps are edited in the env block of the oswiki-sign entry in the AI client\'s config. Never change a setting the user did not ask for.',
  ];
}

export function confirmLine(mode: ConfirmMode, dialog: boolean | undefined): string {
  if (mode === 'off') return 'autonomous (no dialog, OSWIKI_CONFIRM_MODE=off): the AI trades on its own within your limits; sends and limit changes still need the dialog';
  if (mode === 'ai') {
    if (dialog === true) return 'ai (OSWIKI_CONFIRM_MODE=ai): dialog when the client supports it (yours does, so you still approve every trade in the dialog), otherwise the AI\'s confirmation; to stop approving trades use confirmMode off';
    if (dialog === false) return 'WARNING - OSWIKI_CONFIRM_MODE=ai: dialog when the client supports it (yours doesn\'t), otherwise the AI\'s confirmation, so execute runs on the AI\'s word alone';
    return 'ai (OSWIKI_CONFIRM_MODE=ai): dialog when the client supports it, otherwise the AI\'s confirmation';
  }
  if (dialog === true) return 'human (OSWIKI_CONFIRM_MODE=human): you approve every trade in the dialog (or the browser approval page when the client has no dialog)';
  if (dialog === false) return 'this MCP client cannot show the confirmation dialog and the browser approval page is off (OSWIKI_BROWSER_APPROVAL=0), so execute is refused (OSWIKI_CONFIRM_MODE=human)';
  return 'human (OSWIKI_CONFIRM_MODE=human): you approve every trade in the dialog of the MCP client';
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
