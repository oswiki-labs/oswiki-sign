import type { Config, ConfirmMode } from '../config.js';
import { ConfirmError } from '../confirm.js';
import { APECHAIN_ID, MAINNET_ID, type SupportedChainId } from '../constants.js';
import { PACKAGE_NAME } from '../setup.js';
import type { Overrides, OverridableKey, SettingsStore } from '../settings.js';
import { VERSION } from '../version.js';
import { ADDRESS_RE, GuardError, type Ctx } from './common.js';
import { settingValues } from './status.js';

type Amount = string | number;

export interface CollectionChange {
  add?: string[];
  remove?: string[];
  clear?: boolean;
}

export interface LimitsInput {
  maxBuyEth?: Amount | null;
  maxBuyApe?: Amount | null;
  dailyMaxEth?: Amount;
  dailyMaxApe?: Amount;
  dailyMaxSendEth?: Amount;
  dailyMaxSendApe?: Amount;
  minListFloorPct?: number;
  maxTradesPerDay?: number;
  maxCancelsPerDay?: number;
  dryRun?: boolean;
  confirmMode?: ConfirmMode;
  allowedCollections?: CollectionChange;
  blockedCollections?: Omit<CollectionChange, 'clear'>;
}

export interface Approver {
  available(): boolean;
  ask(message: string, title?: string): Promise<'confirmed' | 'declined'>;
}

const CHAIN_NAME: Record<SupportedChainId, string> = { [MAINNET_ID]: 'Ethereum', [APECHAIN_ID]: 'ApeChain' };

export const NO_DIALOG_SETTINGS = `Refused: changing settings from the chat needs the user's approval in oswiki-sign's own dialog, and this MCP client cannot show it. The user can run \`npx -y ${PACKAGE_NAME}@${VERSION} setup\` again in their own terminal (it keeps the wallet), then restart the AI client. Nothing was changed.`;

function addresses(list: string[] | undefined, field: string): string[] {
  const values = (list ?? []).map(entry => entry.trim());
  const bad = values.find(entry => !ADDRESS_RE.test(entry));
  if (bad !== undefined) throw new GuardError(`${field} takes 0x collection addresses only (look names up with the hosted oswiki tools); "${bad.slice(0, 60)}" is not one. Nothing was changed.`);
  return values.map(entry => entry.toLowerCase());
}

function nextCollections(current: ReadonlySet<string> | null, change: CollectionChange, field: string, emptyMeansAny: boolean): string {
  const set = new Set(change.clear ? [] : current ?? []);
  for (const address of addresses(change.remove, `${field}.remove`)) set.delete(address);
  for (const address of addresses(change.add, `${field}.add`)) set.add(address);
  if (emptyMeansAny && set.size === 0 && current && current.size > 0 && !change.clear) {
    throw new GuardError('Removing every collection from the allowlist would allow any collection. Pass clear: true only if the user asked to allow any collection. Nothing was changed.');
  }
  return [...set].join(',');
}

export function nextOverrides(current: Overrides, config: Config, input: LimitsInput): Overrides {
  const next: Overrides = { ...current };
  const set = (key: OverridableKey, value: string | undefined) => {
    if (value !== undefined) next[key] = value;
  };
  const text = (value: Amount | null | undefined) => (value === undefined ? undefined : value === null ? '' : String(value).trim());
  set('OSWIKI_MAX_BUY_ETH', text(input.maxBuyEth));
  set('OSWIKI_MAX_BUY_APE', text(input.maxBuyApe));
  set('OSWIKI_DAILY_MAX_ETH', text(input.dailyMaxEth));
  set('OSWIKI_DAILY_MAX_APE', text(input.dailyMaxApe));
  set('OSWIKI_DAILY_MAX_SEND_ETH', text(input.dailyMaxSendEth));
  set('OSWIKI_DAILY_MAX_SEND_APE', text(input.dailyMaxSendApe));
  set('OSWIKI_MIN_LIST_FLOOR_PCT', input.minListFloorPct === undefined ? undefined : String(input.minListFloorPct));
  set('OSWIKI_MAX_TRADES_PER_DAY', input.maxTradesPerDay === undefined ? undefined : String(input.maxTradesPerDay));
  set('OSWIKI_MAX_CANCELS_PER_DAY', input.maxCancelsPerDay === undefined ? undefined : String(input.maxCancelsPerDay));
  set('OSWIKI_DRY_RUN', input.dryRun === undefined ? undefined : input.dryRun ? '1' : '0');
  set('OSWIKI_CONFIRM_MODE', input.confirmMode);
  if (input.allowedCollections) set('OSWIKI_ALLOWED_COLLECTIONS', nextCollections(config.allowedCollections, input.allowedCollections, 'allowedCollections', true));
  if (input.blockedCollections) set('OSWIKI_BLOCKED_COLLECTIONS', nextCollections(config.blockedCollections, input.blockedCollections, 'blockedCollections', false));
  return next;
}

export function settingsDiff(before: Config, after: Config): string[] {
  const old = new Map(settingValues(before));
  return settingValues(after).filter(([key, value]) => old.get(key) !== value).map(([key, value]) => `- ${key}: ${old.get(key)} -> ${value}`);
}

async function collectionNames(ctx: Ctx, input: LimitsInput): Promise<string[]> {
  const added = [...(input.allowedCollections?.add ?? []), ...(input.blockedCollections?.add ?? [])].filter(entry => ADDRESS_RE.test(entry)).slice(0, 20);
  const rows = await Promise.all(added.map(async (address) => {
    const found = await Promise.all(([MAINNET_ID, APECHAIN_ID] as const).map(chainId => ctx.api.collection(chainId, address).then(info => (info.name ? `${info.name} (${CHAIN_NAME[chainId]})` : null), () => null)));
    const names = found.filter(Boolean);
    return `  ${address.toLowerCase()}: ${names.length > 0 ? names.join(', ') : 'name unknown'}`;
  }));
  return rows.length > 0 ? ['Collections:', ...rows] : [];
}

/** Every change, tighter or looser, needs the user's approval in the dialog; without a dialog nothing changes. */
export async function updateLimits(ctx: Ctx, settings: SettingsStore, approver: Approver, input: LimitsInput): Promise<{ text: string; modeChanged: boolean }> {
  const next = nextOverrides(settings.overrides, ctx.config, input);
  let after: Config;
  try {
    after = settings.preview(next);
  } catch (err) {
    throw new GuardError(`${err instanceof Error ? err.message : 'Invalid value.'} Nothing was changed.`);
  }
  const diff = settingsDiff(ctx.config, after);
  if (diff.length === 0) return { text: 'Nothing to change: these values are already in force.', modeChanged: false };
  if (!approver.available()) throw new ConfirmError(NO_DIALOG_SETTINGS);

  const names = await collectionNames(ctx, input);
  const message = [
    'oswiki-sign (your local signer, not the AI) asks you to approve these setting changes:',
    '',
    ...diff,
    ...names,
    '',
    'They apply right away and are saved in ~/.oswiki-sign/settings.json.',
  ].join('\n');
  let decision: 'confirmed' | 'declined';
  try {
    decision = await approver.ask(message, 'Apply these setting changes');
  } catch {
    throw new ConfirmError('The confirmation dialog failed. Nothing was changed.');
  }
  if (decision !== 'confirmed') throw new ConfirmError('The user did not approve the setting changes in the dialog. Nothing was changed. Do not retry unless the user asks again.');

  const before = ctx.config;
  ctx.config = settings.save(next);
  const modeChanged = before.confirmMode !== ctx.config.confirmMode;
  return {
    text: [
      'Settings updated (approved by the user in the oswiki-sign dialog), in effect now without a restart:',
      ...diff,
      modeChanged ? 'The confirmation mode applies to the next execute. The tool descriptions refresh when the client reloads the tool list; the server instructions on the next restart.' : '',
    ].filter(Boolean).join('\n'),
    modeChanged,
  };
}
