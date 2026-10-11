import { encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';

import { WRAPPED_NATIVE_ABI } from '../abi.js';
import { sanitizeServerText } from '../api.js';
import { gasLimitCap, networkFee, sendGuardedTx, type SendTarget, type TxKind, type TxRequest } from '../chain.js';
import type { Config } from '../config.js';
import { APECHAIN_ID, MAINNET_ID, NATIVE_SYMBOL, OPENSEA_CONDUIT_ADDRESS, SEAPORT_ADDRESS, WRAPPED_NATIVE, WRAPPED_SYMBOL, type SupportedChainId } from '../constants.js';
import { native, parsePositiveAmount, PriceInputError, wrapped } from '../format.js';
import { isConduitRestriction, revertMessage } from '../seaport/fulfill.js';
import type { Charge, Limits } from '../state.js';
import { ERC1155_TRANSFER_ABI, ERC721_SAFE_TRANSFER_ABI, WRAPPED_TRANSFER_ABI } from '../transfer-abi.js';
import { ADDRESS_RE, chainOf, GuardError, me, readIsErc1155, TOKEN_ID_RE, type Ctx } from './common.js';
import { looksLikeEnsName, normalizeEnsName, resolveEnsName, reverseEnsName } from './ens.js';

export const MAX_TRANSFER_ITEMS = 50;

const CHAIN_NAME: Record<SupportedChainId, string> = { [MAINNET_ID]: 'Ethereum', [APECHAIN_ID]: 'ApeChain' };
const BURN_ADDRESSES = new Set<string>([
  zeroAddress,
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
  '0x0000000000000000000000000000000000000001',
]);
const EIP7702_PREFIX = '0xef0100';

export const NO_DIALOG_SEND = 'Refused: sending NFTs or funds needs your approval in oswiki-sign\'s own dialog, and this MCP client cannot show it (MCP elicitation). Sending is never allowed on the AI\'s word, whatever OSWIKI_CONFIRM_MODE says. Use an MCP client that supports elicitation, or send from your wallet app. Nothing was sent.';

type Amount = string | number;

export interface TransferInput {
  chainId: number;
  to: string;
  items?: Array<{ contract: string; tokenId: string; amount?: number }>;
  nativeAmount?: Amount;
  wrappedAmount?: Amount;
}

export interface TransferGroup {
  contract: Address;
  standard: 'erc721' | 'erc1155';
  items: Array<{ tokenId: string; amount: bigint }>;
}

export interface TransferPlan {
  kind: 'transfer';
  chainId: SupportedChainId;
  wallet: Address;
  recipient: Address;
  recipientName: string | null;
  groups: TransferGroup[];
  nativeWei: bigint;
  wrappedWei: bigint;
}

export interface UnwrapPlan {
  kind: 'unwrap';
  chainId: SupportedChainId;
  wallet: Address;
  amountWei: bigint;
}

interface PlannedTx {
  label: string;
  tx: TxRequest;
  kind: TxKind;
  orders: number;
  group?: TransferGroup;
}

export function transferCharge(plan: TransferPlan): Charge {
  const trades = plan.groups.reduce((sum, group) => sum + group.items.length, 0);
  return { chainId: plan.chainId, trades, sendWei: plan.nativeWei + plan.wrappedWei };
}

function limitsFor(config: Config): Limits {
  return { maxTrades: config.maxTradesPerDay, maxCancels: config.maxCancelsPerDay, dailyMaxWei: config.dailyMaxWei, dailySendWei: config.dailyMaxSendWei };
}

function itemLabel(contract: string, tokenId: string, amount: bigint, standard: TransferGroup['standard']): string {
  return `${contract} #${tokenId}${standard === 'erc1155' ? ` x${amount}` : ''}`;
}

function amountOf(value: Amount | undefined, field: string): bigint {
  if (value === undefined) return 0n;
  try {
    return parsePositiveAmount(value, field);
  } catch (err) {
    throw new GuardError(`${err instanceof PriceInputError ? err.message : `${field} is not a valid amount.`} Nothing was sent.`);
  }
}

async function resolveRecipient(ctx: Ctx, input: string): Promise<{ address: Address; ensInput: string | null }> {
  const value = (input ?? '').trim();
  if (ADDRESS_RE.test(value)) return { address: value.toLowerCase() as Address, ensInput: null };
  if (!looksLikeEnsName(value)) throw new GuardError('The recipient must be a full 0x address (40 hex characters) or an ENS name like name.eth that the user gave you. Nothing was sent.');
  const name = normalizeEnsName(value);
  let address: Address | null;
  try {
    address = await resolveEnsName(ctx.chains.client(MAINNET_ID), name);
  } catch {
    throw new GuardError(`Could not look up the ENS name ${name} on Ethereum right now. Try again, or ask the user for the full 0x address. Nothing was sent.`);
  }
  if (!address) throw new GuardError(`The ENS name ${name} does not resolve to an address (or uses an off-chain resolver this signer does not follow). Ask the user for the full 0x address. Nothing was sent.`);
  return { address, ensInput: name };
}

function assertRecipient(ctx: Ctx, chainId: SupportedChainId, recipient: Address, contracts: string[], funds: boolean): void {
  if (BURN_ADDRESSES.has(recipient)) throw new GuardError(`Refused: ${recipient} is the zero or a burn address; whatever is sent there is lost for good. Nothing was sent.`);
  if (recipient === me(ctx)) throw new GuardError('Refused: the recipient is this wallet itself. Nothing was sent.');
  if (contracts.includes(recipient)) throw new GuardError(`Refused: the recipient ${recipient} is the NFT contract itself; tokens sent to their own contract are usually lost. Nothing was sent.`);
  if (recipient === WRAPPED_NATIVE[chainId]!.toLowerCase()) {
    throw new GuardError(`Refused: the recipient ${recipient} is the ${WRAPPED_SYMBOL[chainId]} token contract itself${funds ? '; to turn it into ' + NATIVE_SYMBOL[chainId] + ' use preview_unwrap' : ''}. Nothing was sent.`);
  }
  if (recipient === SEAPORT_ADDRESS || recipient === OPENSEA_CONDUIT_ADDRESS) throw new GuardError(`Refused: the recipient ${recipient} is a marketplace contract, not a wallet. Nothing was sent.`);
}

function nftTxs(plan: Pick<TransferPlan, 'chainId' | 'wallet' | 'recipient' | 'groups'>): PlannedTx[] {
  const { chainId, wallet, recipient } = plan;
  return plan.groups.flatMap((group): PlannedTx[] => {
    if (group.standard === 'erc721') {
      return group.items.map(item => ({
        label: `${group.contract} #${item.tokenId}`,
        tx: { chainId, to: group.contract, value: 0n, data: encodeFunctionData({ abi: ERC721_SAFE_TRANSFER_ABI, functionName: 'safeTransferFrom', args: [wallet, recipient, BigInt(item.tokenId)] }) },
        kind: 'transfer721',
        orders: 1,
        group: { ...group, items: [item] },
      }));
    }
    if (group.items.length === 1) {
      const item = group.items[0]!;
      return [{
        label: itemLabel(group.contract, item.tokenId, item.amount, 'erc1155'),
        tx: { chainId, to: group.contract, value: 0n, data: encodeFunctionData({ abi: ERC1155_TRANSFER_ABI, functionName: 'safeTransferFrom', args: [wallet, recipient, BigInt(item.tokenId), item.amount, '0x'] }) },
        kind: 'transfer1155',
        orders: 1,
        group,
      }];
    }
    return [{
      label: `${group.contract} ${group.items.map(item => `#${item.tokenId} x${item.amount}`).join(', ')} (one batch)`,
      tx: { chainId, to: group.contract, value: 0n, data: encodeFunctionData({ abi: ERC1155_TRANSFER_ABI, functionName: 'safeBatchTransferFrom', args: [wallet, recipient, group.items.map(item => BigInt(item.tokenId)), group.items.map(item => item.amount), '0x'] }) },
      kind: 'transfer1155Batch',
      orders: group.items.length,
      group,
    }];
  });
}

function fundTxs(plan: Pick<TransferPlan, 'chainId' | 'recipient' | 'nativeWei' | 'wrappedWei'>): PlannedTx[] {
  const { chainId, recipient } = plan;
  const txs: PlannedTx[] = [];
  if (plan.wrappedWei > 0n) {
    txs.push({
      label: wrapped(plan.wrappedWei, chainId),
      tx: { chainId, to: WRAPPED_NATIVE[chainId]!, value: 0n, data: encodeFunctionData({ abi: WRAPPED_TRANSFER_ABI, functionName: 'transfer', args: [recipient, plan.wrappedWei] }) },
      kind: 'erc20Transfer',
      orders: 1,
    });
  }
  if (plan.nativeWei > 0n) txs.push({ label: native(plan.nativeWei, chainId), tx: { chainId, to: recipient, value: plan.nativeWei, data: '0x' }, kind: 'send', orders: 1 });
  return txs;
}

export function plannedTxs(plan: TransferPlan): PlannedTx[] {
  return [...nftTxs(plan), ...fundTxs(plan)];
}

async function simulate(client: PublicClient, from: Address, tx: TxRequest): Promise<unknown | null> {
  try {
    await client.call({ account: from, to: tx.to, data: tx.data, value: tx.value });
    return null;
  } catch (err) {
    return err;
  }
}

function blockedReason(err: unknown, recipientIsContract: boolean): string {
  if (isConduitRestriction(err)) return 'this collection doesn\'t allow direct transfers (its transfer validator / ERC721-C rules block this wallet-to-wallet transfer)';
  const reason = revertMessage(err);
  return recipientIsContract
    ? `the transfer reverts in simulation (${reason}); the collection may not allow direct transfers, or the recipient contract does not accept NFTs`
    : `the transfer reverts in simulation (${reason}); this collection may not allow direct transfers`;
}

/** Per-item reasons the NFTs cannot be sent; a failing 1155 batch is split to find the items at fault. */
async function nftProblems(ctx: Ctx, plan: Pick<TransferPlan, 'chainId' | 'wallet' | 'recipient' | 'groups'>, recipientIsContract: boolean): Promise<string[]> {
  const client = ctx.chains.client(plan.chainId);
  const problems: string[] = [];
  for (const planned of nftTxs(plan)) {
    const err = await simulate(client, plan.wallet, planned.tx);
    if (err === null) continue;
    const group = planned.group!;
    if (planned.kind !== 'transfer1155Batch') {
      for (const item of group.items) problems.push(`- ${itemLabel(group.contract, item.tokenId, item.amount, group.standard)}: ${blockedReason(err, recipientIsContract)}.`);
      continue;
    }
    let found = false;
    for (const item of group.items) {
      const single = nftTxs({ ...plan, groups: [{ ...group, items: [item] }] })[0]!;
      const itemErr = await simulate(client, plan.wallet, single.tx);
      if (itemErr === null) continue;
      found = true;
      problems.push(`- ${itemLabel(group.contract, item.tokenId, item.amount, 'erc1155')}: ${blockedReason(itemErr, recipientIsContract)}.`);
    }
    if (!found) problems.push(`- ${planned.label}: ${blockedReason(err, recipientIsContract)}.`);
  }
  return problems;
}

async function ownershipProblems(client: PublicClient, owner: Address, groups: TransferGroup[]): Promise<string[]> {
  const rows = await Promise.all(groups.flatMap(group => group.items.map(async (item) => {
    const label = itemLabel(group.contract, item.tokenId, item.amount, group.standard);
    try {
      if (group.standard === 'erc1155') {
        const balance = await client.readContract({ address: group.contract, abi: ERC1155_BALANCE_ABI, functionName: 'balanceOf', args: [owner, BigInt(item.tokenId)] });
        return balance < item.amount ? `- ${label}: this wallet holds ${balance}, not ${item.amount}.` : null;
      }
      const holder = await client.readContract({ address: group.contract, abi: ERC721_OWNER_ABI, functionName: 'ownerOf', args: [BigInt(item.tokenId)] });
      return holder.toLowerCase() !== owner.toLowerCase() ? `- ${label}: this wallet does not own it.` : null;
    } catch {
      return `- ${label}: could not read its owner on-chain (wrong contract or token id?).`;
    }
  })));
  return rows.filter((row): row is string => row !== null);
}

const ERC721_OWNER_ABI = [{ name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] }] as const;
const ERC1155_BALANCE_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }] as const;

function collectionProblems(config: Config, groups: TransferGroup[]): string[] {
  return groups.flatMap((group) => {
    const contract = group.contract.toLowerCase();
    let reason: string | null = null;
    if (config.allowedCollections && !config.allowedCollections.has(contract)) reason = 'the collection is not in OSWIKI_ALLOWED_COLLECTIONS';
    if (config.blockedCollections?.has(contract)) reason = 'the collection is blocked (OSWIKI_BLOCKED_COLLECTIONS)';
    return reason ? group.items.map(item => `- ${itemLabel(group.contract, item.tokenId, item.amount, group.standard)}: ${reason}.`) : [];
  });
}

function problemsError(problems: string[]): GuardError {
  return new GuardError(['These items cannot be sent:', ...problems, 'Nothing was sent. Tell the user, and preview again without them if they still want to send the rest.'].join('\n'));
}

async function buildGroups(ctx: Ctx, chainId: SupportedChainId, items: NonNullable<TransferInput['items']>): Promise<TransferGroup[]> {
  const seen = new Set<string>();
  const byContract = new Map<Address, Array<{ tokenId: string; amount: bigint }>>();
  for (const item of items) {
    const contract = item.contract.trim();
    if (!ADDRESS_RE.test(contract)) throw new GuardError(`"${contract.slice(0, 60)}" is not a 0x collection address. Nothing was sent.`);
    if (!TOKEN_ID_RE.test(item.tokenId)) throw new GuardError(`Token id "${String(item.tokenId).slice(0, 80)}" must be a decimal number. Nothing was sent.`);
    const key = `${contract.toLowerCase()}:${item.tokenId}`;
    if (seen.has(key)) throw new GuardError(`${contract.toLowerCase()} #${item.tokenId} is listed twice; pass each token once (use amount for ERC-1155). Nothing was sent.`);
    seen.add(key);
    const list = byContract.get(contract.toLowerCase() as Address) ?? [];
    list.push({ tokenId: item.tokenId, amount: BigInt(item.amount ?? 1) });
    byContract.set(contract.toLowerCase() as Address, list);
  }
  const client = ctx.chains.client(chainId);
  return Promise.all([...byContract].map(async ([contract, list]) => {
    const isErc1155 = await readIsErc1155(client, contract);
    if (!isErc1155) {
      const bad = list.find(item => item.amount !== 1n);
      if (bad) throw new GuardError(`${contract} is an ERC-721 collection: #${bad.tokenId} can only be sent once (amount 1). Nothing was sent.`);
    }
    return { contract, standard: isErc1155 ? 'erc1155' : 'erc721', items: list } satisfies TransferGroup;
  }));
}

interface RecipientFacts {
  isContract: boolean;
  delegated: boolean;
  fresh: boolean;
  name: string | null;
}

async function recipientFacts(ctx: Ctx, chainId: SupportedChainId, recipient: Address): Promise<RecipientFacts> {
  const client = ctx.chains.client(chainId);
  const [code, nonce, balance, name] = await Promise.all([
    client.getCode({ address: recipient }).catch(() => undefined),
    client.getTransactionCount({ address: recipient }).catch(() => null),
    client.getBalance({ address: recipient }).catch(() => null),
    reverseEnsName(ctx.chains.client(MAINNET_ID), recipient),
  ]);
  const hasCode = code !== undefined && code !== '0x' && code.length > 2;
  const delegated = hasCode && code!.toLowerCase().startsWith(EIP7702_PREFIX);
  return { isContract: hasCode && !delegated, delegated, fresh: nonce === 0 && balance === 0n && !hasCode, name };
}

function recipientLines(plan: TransferPlan, ensInput: string | null, facts: RecipientFacts): string[] {
  const { chainId, recipient } = plan;
  const lines = [`Recipient: ${recipient}`];
  if (ensInput) lines.push(`  ENS: ${ensInput} resolves to ${recipient} on Ethereum right now. Check the full address with the user.`);
  else if (facts.name) lines.push(`  ENS name of this address: ${facts.name}`);
  else lines.push('  No ENS name. Check the full address with the user character by character.');
  if (facts.isContract) lines.push(`  WARNING: the recipient is a CONTRACT on ${CHAIN_NAME[chainId]}, not a plain wallet. Only send if the user knows it is their smart wallet (e.g. a Safe) or a contract that can hand the items on; anything else may be lost for good.`);
  if (facts.delegated) lines.push('  NOTE: the recipient is a wallet with an EIP-7702 smart-account delegation.');
  if (facts.fresh) lines.push(`  NOTE: new recipient: this address has never sent a transaction and holds no ${NATIVE_SYMBOL[chainId]} on ${CHAIN_NAME[chainId]}. Make sure it is the right address.`);
  return lines;
}

/** Everything a send needs checked against the chain right now; throws with per-item reasons. */
async function checkSendable(ctx: Ctx, plan: TransferPlan, recipientIsContract: boolean): Promise<{ nativeBalance: bigint; wrappedBalance: bigint }> {
  const client = ctx.chains.client(plan.chainId);
  const configProblems = collectionProblems(ctx.config, plan.groups);
  if (configProblems.length > 0) throw problemsError(configProblems);
  const owned = await ownershipProblems(client, plan.wallet, plan.groups);
  if (owned.length > 0) throw problemsError(owned);
  const [nativeBalance, wrappedBalance] = await Promise.all([
    client.getBalance({ address: plan.wallet }),
    plan.wrappedWei > 0n ? client.readContract({ address: WRAPPED_NATIVE[plan.chainId]!, abi: WRAPPED_NATIVE_ABI, functionName: 'balanceOf', args: [plan.wallet] }) : Promise.resolve(0n),
  ]);
  if (plan.nativeWei > nativeBalance) throw new GuardError(`Not enough ${NATIVE_SYMBOL[plan.chainId]}: sending ${native(plan.nativeWei, plan.chainId)}, the wallet has ${native(nativeBalance, plan.chainId)}. Nothing was sent.`);
  if (plan.wrappedWei > wrappedBalance) throw new GuardError(`Not enough ${WRAPPED_SYMBOL[plan.chainId]}: sending ${wrapped(plan.wrappedWei, plan.chainId)}, the wallet has ${wrapped(wrappedBalance, plan.chainId)}. Nothing was sent.`);
  const blocked = await nftProblems(ctx, plan, recipientIsContract);
  if (blocked.length > 0) throw problemsError(blocked);
  const fundClient = ctx.chains.client(plan.chainId);
  for (const planned of fundTxs(plan)) {
    const err = await simulate(fundClient, plan.wallet, planned.tx);
    if (err !== null) throw new GuardError(`Sending ${planned.label} would fail in simulation (${revertMessage(err)}). Nothing was sent.`);
  }
  return { nativeBalance, wrappedBalance };
}

export async function previewTransfer(ctx: Ctx, input: TransferInput): Promise<{ text: string; plan: TransferPlan }> {
  const chainId = chainOf(input.chainId);
  const items = input.items ?? [];
  if (items.length > MAX_TRANSFER_ITEMS) throw new GuardError(`Send at most ${MAX_TRANSFER_ITEMS} NFTs at once. Nothing was sent.`);
  const nativeWei = amountOf(input.nativeAmount, 'nativeAmount');
  const wrappedWei = amountOf(input.wrappedAmount, 'wrappedAmount');
  if (items.length === 0 && nativeWei === 0n && wrappedWei === 0n) throw new GuardError('Nothing to send: pass items (NFTs) and/or nativeAmount / wrappedAmount. Nothing was sent.');

  const { address: recipient, ensInput } = await resolveRecipient(ctx, input.to);
  const groups = await buildGroups(ctx, chainId, items);
  assertRecipient(ctx, chainId, recipient, groups.map(group => group.contract), nativeWei + wrappedWei > 0n);

  const plan: TransferPlan = { kind: 'transfer', chainId, wallet: me(ctx), recipient, recipientName: null, groups, nativeWei, wrappedWei };
  ctx.state.check(transferCharge(plan), limitsFor(ctx.config));
  const facts = await recipientFacts(ctx, chainId, recipient);
  plan.recipientName = ensInput ?? facts.name;
  const { nativeBalance, wrappedBalance } = await checkSendable(ctx, plan, facts.isContract);

  const client = ctx.chains.client(chainId);
  const txs = plannedTxs(plan);
  const estimates = await Promise.all(txs.map(planned => client.estimateGas({ account: plan.wallet, to: planned.tx.to, data: planned.tx.data, value: planned.tx.value }).catch(() => undefined)));
  txs.forEach((planned, i) => {
    const estimate = estimates[i];
    const cap = gasLimitCap(chainId, { kind: planned.kind, orders: planned.orders });
    if (estimate !== undefined && estimate > cap) {
      const hint = planned.kind === 'send' ? ` A plain ${NATIVE_SYMBOL[chainId]} transfer to this recipient needs more gas than a normal wallet does (it is a contract); send ${WRAPPED_SYMBOL[chainId]} instead or ask the user for a regular wallet address.` : '';
      throw new GuardError(`Sending ${planned.label} needs ${estimate} gas, above the limit of ${cap} for this kind of transfer.${hint} Nothing was sent.`);
    }
  });
  const fee = await networkFee(ctx.chains, chainId, txs.map((planned, i) => ({ shape: { kind: planned.kind, orders: planned.orders }, estimate: estimates[i] })));

  const names = new Map(await Promise.all(groups.map(async group => [group.contract, await ctx.api.collection(chainId, group.contract).then(info => info.name || null, () => null)] as const)));
  const nftCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const sendCap = ctx.config.dailyMaxSendWei[chainId];
  const lines = [
    `PREVIEW: SEND from ${plan.wallet} on ${CHAIN_NAME[chainId]}. This leaves the wallet and cannot be undone.`,
    ...recipientLines(plan, ensInput, facts),
  ];
  if (nftCount > 0) {
    lines.push(`NFTs (${nftCount}):`);
    for (const group of groups) {
      const name = names.get(group.contract) ?? 'name unknown';
      for (const item of group.items) lines.push(`- ${name} ${itemLabel(group.contract, item.tokenId, item.amount, group.standard)} (${group.standard === 'erc721' ? 'ERC-721' : 'ERC-1155'})`);
    }
  }
  if (nativeWei + wrappedWei > 0n) {
    lines.push('Funds:');
    if (wrappedWei > 0n) lines.push(`- ${wrapped(wrappedWei, chainId)} (wallet has ${wrapped(wrappedBalance, chainId)})`);
    if (nativeWei > 0n) lines.push(`- ${native(nativeWei, chainId)} (wallet has ${native(nativeBalance, chainId)})`);
    lines.push(`Sent today on ${CHAIN_NAME[chainId]}: ${native(ctx.state.sentToday(chainId), chainId)} of ${sendCap === null ? 'no limit set' : native(sendCap, chainId)} (OSWIKI_DAILY_MAX_SEND_${NATIVE_SYMBOL[chainId]}).`);
  }
  if (nativeWei > 0n && fee.maxWei > 0n && nativeBalance - nativeWei < fee.maxWei) {
    lines.push(`WARNING: after sending ${native(nativeWei, chainId)} the wallet may not have enough ${NATIVE_SYMBOL[chainId]} left for the network fee; the send could fail.`);
  }
  lines.push(
    `Transactions (${txs.length}, sent one after another): ${txs.map(planned => planned.label).join('; ')}.`,
    fee.text,
    'Ownership and a simulation of every transaction passed just now.',
  );
  return { text: lines.join('\n'), plan };
}

export async function executeTransfer(ctx: Ctx, plan: TransferPlan, commit: () => void): Promise<string> {
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  assertRecipient(ctx, plan.chainId, plan.recipient, plan.groups.map(group => group.contract), plan.nativeWei + plan.wrappedWei > 0n);
  const facts = await recipientFacts(ctx, plan.chainId, plan.recipient);
  await checkSendable(ctx, plan, facts.isContract);

  const target: SendTarget = { from: plan.wallet, to: plan.recipient };
  const contracts = new Set(plan.groups.map(group => group.contract.toLowerCase()));
  const done: string[] = [];
  commit();
  for (const planned of plannedTxs(plan)) {
    try {
      const sent = await sendGuardedTx(ctx.chains, ctx.account, planned.tx, contracts, target);
      done.push(`- ${planned.label}: sent, transaction ${sent.hash} confirmed.`);
    } catch (err) {
      const reason = sanitizeServerText((err as Error)?.message, 400) || 'unknown error';
      const lines = [
        done.length > 0 ? `Partly sent to ${plan.recipient}:` : `Nothing was sent to ${plan.recipient}:`,
        ...done,
        `- ${planned.label}: FAILED (${reason})`,
        'The remaining transfers were not attempted. Tell the user exactly what was and was not sent; preview again for the rest if they want.',
      ];
      throw new SendStoppedError(lines.join('\n'));
    }
  }
  return [`Sent to ${plan.recipient}${plan.recipientName ? ` (${plan.recipientName})` : ''} on ${CHAIN_NAME[plan.chainId]}:`, ...done].join('\n');
}

/** Built only from our own text and sanitized error text, and must reach the AI whole. */
export class SendStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendStoppedError';
  }
}

function unwrapTx(chainId: SupportedChainId, amountWei: bigint): TxRequest {
  return { chainId, to: WRAPPED_NATIVE[chainId]!, value: 0n, data: encodeFunctionData({ abi: WRAPPED_TRANSFER_ABI, functionName: 'withdraw', args: [amountWei] }) as Hex };
}

async function checkUnwrap(ctx: Ctx, chainId: SupportedChainId, amountWei: bigint): Promise<bigint> {
  const client = ctx.chains.client(chainId);
  const balance = await client.readContract({ address: WRAPPED_NATIVE[chainId]!, abi: WRAPPED_NATIVE_ABI, functionName: 'balanceOf', args: [ctx.account.address] });
  if (amountWei > balance) throw new GuardError(`Not enough ${WRAPPED_SYMBOL[chainId]}: unwrapping ${wrapped(amountWei, chainId)}, the wallet has ${wrapped(balance, chainId)}. Nothing was sent.`);
  const err = await simulate(client, ctx.account.address, unwrapTx(chainId, amountWei));
  if (err !== null) throw new GuardError(`The unwrap would fail in simulation (${revertMessage(err)}). Nothing was sent.`);
  return balance;
}

export async function previewUnwrap(ctx: Ctx, input: { chainId: number; amount: Amount }): Promise<{ text: string; plan: UnwrapPlan }> {
  const chainId = chainOf(input.chainId);
  const amountWei = amountOf(input.amount, 'amount');
  const balance = await checkUnwrap(ctx, chainId, amountWei);
  const tx = unwrapTx(chainId, amountWei);
  const estimate = await ctx.chains.client(chainId).estimateGas({ account: ctx.account.address, to: tx.to, data: tx.data }).catch(() => undefined);
  const fee = await networkFee(ctx.chains, chainId, [{ shape: { kind: 'unwrap', orders: 1 }, estimate }]);
  const plan: UnwrapPlan = { kind: 'unwrap', chainId, wallet: me(ctx), amountWei };
  return {
    plan,
    text: [
      `PREVIEW: unwrap ${wrapped(amountWei, chainId)} into ${native(amountWei, chainId)} in ${plan.wallet} on ${CHAIN_NAME[chainId]} (wallet has ${wrapped(balance, chainId)}). Nothing leaves the wallet.`,
      fee.text,
      `One transaction to the ${WRAPPED_SYMBOL[chainId]} contract ${WRAPPED_NATIVE[chainId]} (withdraw); the simulation passed just now.`,
    ].join('\n'),
  };
}

export async function executeUnwrap(ctx: Ctx, plan: UnwrapPlan, commit: () => void): Promise<string> {
  if (plan.wallet !== me(ctx)) throw new GuardError('This plan was made for another wallet.');
  await checkUnwrap(ctx, plan.chainId, plan.amountWei);
  commit();
  const sent = await sendGuardedTx(ctx.chains, ctx.account, unwrapTx(plan.chainId, plan.amountWei), new Set());
  return `Unwrapped ${wrapped(plan.amountWei, plan.chainId)} into ${native(plan.amountWei, plan.chainId)}: transaction ${sent.hash} confirmed.`;
}
