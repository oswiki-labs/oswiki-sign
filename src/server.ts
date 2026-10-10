import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BaseError } from 'viem';
import { z } from 'zod';

import { sanitizeErrorText, sanitizeServerText } from './api.js';
import { assertNoPendingTx } from './chain.js';
import type { Config } from './config.js';
import { ConfirmError, ConfirmStore } from './confirm.js';
import { executeAcceptOffer, previewAcceptOffer, type AcceptPlan } from './flows/accept.js';
import { executeBuy, previewBuy, type BuyPlan } from './flows/buy.js';
import { cancelCount, executeCancel, previewCancel, type CancelPlan } from './flows/cancel.js';
import { RejectedOrderError, type Ctx } from './flows/common.js';
import { executeListing, previewListing, type ListingPlan } from './flows/listing.js';
import { executeOffer, previewOffer, type OfferPlan } from './flows/offer.js';
import { myListings, myOffers, walletStatus } from './flows/status.js';
import { CONFIRM_FOOTER } from './format.js';
import type { Scrubber } from './secret.js';
import type { Charge, Limits } from './state.js';
import { VERSION } from './version.js';

export type Plan = ListingPlan | BuyPlan | CancelPlan | OfferPlan | AcceptPlan;

export const SERVER_INSTRUCTIONS = [
  'oswiki-sign is the user\'s LOCAL trading signer for OSWiki (Seaport 1.6 on Ethereum and ApeChain). It holds the wallet key on this machine; the key is never shown to you and you must never ask the user for a private key or seed phrase, nor accept one in chat.',
  'Every trade is two steps: call a preview_* tool, show the user the full preview text (prices, fees, royalties, approvals, warnings), and only after the user explicitly confirms in their own words call execute with the confirmId from that preview. Never call execute on your own initiative, never reuse a confirmId (single use, expires after 10 minutes), and run the preview again if anything changes.',
  'On execute, oswiki-sign shows the user its own confirmation dialog with the previewed trade; only the user can approve it. If the user declines, do not retry unless they ask again.',
  'Prices are always explicit numbers the user agreed to. For research and pricing advice (floors, trait floors, recent sales, rarity) use the hosted oswiki MCP tools, then pass the agreed number here.',
  'Use wallet_status to see the wallet, balances and the limits in force; my_listings / my_offers for the wallet\'s open orders.',
].join('\n');

const chainId = z.union([z.literal(1), z.literal(33139)]).describe('1 = Ethereum, 33139 = ApeChain');
const amount = z.union([z.string(), z.number()]);
const orderId = z.string().describe('OSWiki order id, "oswiki-0x" + 64 hex');
const allowNoFloor = z.boolean().optional().describe('only when the user explicitly confirmed listing/accepting without any floor reference');

const SCHEMAS = {
  wallet_status: z.strictObject({}),
  my_listings: z.strictObject({ chainId: chainId.optional() }),
  my_offers: z.strictObject({ chainId: chainId.optional() }),
  preview_listing: z.strictObject({
    chainId,
    items: z.array(z.strictObject({
      contract: z.string().describe('Collection contract address (0x...)'),
      tokenId: z.string().describe('Token id as a decimal string'),
      price: amount.describe('Explicit price PER TOKEN in ETH (Ethereum) or APE (ApeChain), e.g. "1.25". Must be > 0. Never a word like "floor".'),
      quantity: z.number().int().min(1).optional().describe('ERC-1155 only: how many to list (default 1)'),
    })).min(1).max(100),
    durationDays: z.number().positive().max(365).optional().describe('How long the listing stays valid (default 30)'),
    crossListOpenSea: z.boolean().optional().describe('Also list on OpenSea in the same signature (same or higher price)'),
    openSeaMarkupBps: z.number().int().min(0).max(10000).optional().describe('OpenSea price above the OSWiki price, in basis points (default 0)'),
    allowNoFloor,
  }),
  preview_buy: z.strictObject({
    chainId,
    askIds: z.array(orderId).min(1).max(20).describe('OSWiki askIds to buy (from the hosted oswiki tools or my_listings)'),
  }),
  preview_cancel: z.strictObject({
    chainId,
    askIds: z.array(orderId).max(100).optional(),
    bidIds: z.array(orderId).max(100).optional(),
    orders: z.array(z.record(z.string(), z.unknown())).max(100).optional().describe('Order components of this wallet\'s signed orders that the OSWiki API rejected (exactly as an execute result printed them), to cancel them on-chain'),
  }),
  preview_offer: z.strictObject({
    chainId,
    contract: z.string().describe('Collection contract address (0x...)'),
    tokenId: z.string().optional().describe('Token id for an item offer; omit for a collection offer (any token)'),
    price: amount.describe('Offer amount PER TOKEN in WETH (Ethereum) or WAPE (ApeChain), e.g. "0.8". Must be > 0.'),
    quantity: z.number().int().min(1).max(50).optional().describe('Collection offers only: how many tokens (default 1)'),
    durationDays: z.number().positive().max(365).optional().describe('How long the offer stays valid (default 7)'),
  }),
  preview_accept_offer: z.strictObject({
    chainId,
    bidId: orderId,
    tokenId: z.string().describe('The token of this wallet that the offer buys'),
    allowNoFloor,
  }),
  execute: z.strictObject({ confirmId: z.string().min(1).max(100) }),
} as const;

type ToolName = keyof typeof SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  wallet_status: 'Wallet address, ETH/APE and WETH/WAPE balances on both chains, the limits in force, what is left today and the confirmation mode. Read-only.',
  my_listings: 'Active OSWiki listings of this wallet (askIds for preview_cancel). Read-only.',
  my_offers: 'Active OSWiki offers of this wallet (bidIds for preview_cancel). Read-only.',
  preview_listing: [
    'Step 1 of listing NFTs for sale (1-100 tokens, one chain). Shows price, fee, royalty, payout, approvals, cheaper own listings that get cancelled first, and price references (last sale, recent same-trait sales, floor) with a warning when the price looks too low. Nothing is signed.',
    'Every item needs an explicit positive price per token that the user agreed to. Never pass 0 and never invent a price.',
    'If the user asks to list "at floor" or "at the <trait> floor" (e.g. "at the Otherdeed Chaos floor"), look the number up with the hosted oswiki tools first. If there is no listing for it (no floor, or a floor of 0), do NOT guess, do NOT use 0 and do NOT fall back to the collection floor or any lower reference: a missing trait floor usually means the trait is rare and worth more. Tell the user there is no floor, offer context from the hosted oswiki tools (recent sales of that trait, rarity), and ask them for a price.',
    'For pricing advice use the hosted oswiki tools. Show the whole preview to the user, then ask them to confirm before calling execute.',
  ].join(' '),
  preview_buy: 'Step 1 of buying up to 20 OSWiki listings by askId. Re-checks each order against the chain, simulates the purchase and shows the total and the network fee. Nothing is sent. Show the preview and get the user\'s confirmation before execute.',
  preview_cancel: 'Step 1 of cancelling this wallet\'s OSWiki listings (askIds, incl. their linked OpenSea listings), offers (bidIds) and signed orders the API rejected (orders) on-chain. Shows the network fee. Nothing is sent. Get the user\'s confirmation before execute.',
  preview_offer: 'Step 1 of making an offer in WETH (Ethereum) or WAPE (ApeChain): an item offer (with tokenId) or collection offers (without tokenId, quantity up to 50). Shows the wrap and exact-amount approval needed. Nothing is signed. Get the user\'s confirmation before execute.',
  preview_accept_offer: 'Step 1 of accepting an OSWiki offer (bidId) for a token this wallet holds. Shows what you receive after fee and royalty. Nothing is sent. Get the user\'s confirmation before execute.',
  execute: 'Step 2: runs exactly the previewed plan (approvals, cancels, then sign/submit or the transaction), re-checking counter, ownership and a simulation first. oswiki-sign first asks the user to approve the trade in its own confirmation dialog. Only call this after the user explicitly confirmed that preview. A confirmId works once and expires after 10 minutes.',
};

export const NO_DIALOG_REFUSAL = [
  'Refused: this MCP client cannot show oswiki-sign\'s confirmation dialog (MCP elicitation), and by default oswiki-sign only signs after the user approves the trade in that dialog. Nothing was signed or sent.',
  'Use an MCP client that supports elicitation. Only if the user decides to trust the AI\'s confirmation instead, they can set OSWIKI_CONFIRM_MODE=ai in the env block of oswiki-sign and restart the client.',
].join(' ');

export type HumanDecision = 'confirmed' | 'declined';

export interface HumanConfirmer {
  available(): boolean;
  ask(message: string): Promise<HumanDecision>;
}

export const NO_HUMAN_CONFIRMER: HumanConfirmer = {
  available: () => false,
  ask: async () => 'declined',
};

export const CONFIRM_DIALOG_TIMEOUT_MS = 5 * 60_000;

export function elicitationConfirmer(server: Server, timeoutMs = CONFIRM_DIALOG_TIMEOUT_MS): HumanConfirmer {
  return {
    available: () => server.getClientCapabilities()?.elicitation?.form !== undefined,
    async ask(message) {
      const result = await server.elicitInput({
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Sign and send this trade', description: 'Approve exactly the trade shown above. Decline or leave unticked to cancel.' },
          },
          required: ['confirm'],
        },
      }, { timeout: timeoutMs });
      return result.action === 'accept' && result.content?.confirm === true ? 'confirmed' : 'declined';
    },
  };
}

export function errorText(err: unknown): string {
  if (err instanceof BaseError) return sanitizeErrorText(err);
  if (err instanceof RejectedOrderError) return err.message;
  const message = typeof (err as { message?: unknown } | null)?.message === 'string' ? (err as Error).message : '';
  return sanitizeServerText(message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'), 600) || 'unknown error';
}

export function limitsOf(config: Config): Limits {
  return { maxTrades: config.maxTradesPerDay, maxCancels: config.maxCancelsPerDay, dailyMaxWei: config.dailyMaxWei };
}

/** Every item of an execute counts: listed tokens, bought listings, offers, accepted offers, cancelled orders. */
export function chargeOf(plan: Plan): Charge {
  switch (plan.kind) {
    case 'listing': return { chainId: plan.chainId, trades: plan.items.length, cancels: plan.cancels.filter(target => !target.twinOf).length };
    case 'buy': return { chainId: plan.chainId, trades: plan.entries.length, spendWei: plan.totalValue };
    case 'offer': return { chainId: plan.chainId, trades: plan.quantity, spendWei: plan.amountWei * BigInt(plan.quantity) };
    case 'accept': return { chainId: plan.chainId, trades: 1 };
    case 'cancel': return { chainId: plan.chainId, cancels: cancelCount(plan) };
  }
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface ToolHandler {
  (name: string, args: unknown): Promise<ToolResult>;
  store: ConfirmStore<Plan>;
  confirmer: HumanConfirmer;
}

export function createToolHandler(ctx: Ctx, scrub: Scrubber, options: { store?: ConfirmStore<Plan>; confirmer?: HumanConfirmer } = {}): ToolHandler {
  const store = options.store ?? new ConfirmStore<Plan>(ctx.now);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const modeNote = (): string => {
    if (handler.confirmer.available()) return 'On execute, oswiki-sign asks the user to approve this exact trade in its own confirmation dialog.';
    if (ctx.config.confirmMode === 'ai') return 'WARNING - CONFIRM MODE AI (OSWIKI_CONFIRM_MODE=ai): there is no confirmation dialog, execute runs on the AI\'s word alone. Only call execute after the user explicitly confirmed this exact preview.';
    return 'This MCP client cannot show the confirmation dialog, so execute will be refused (OSWIKI_CONFIRM_MODE is human).';
  };

  const withConfirm = async (preview: Promise<{ text: string; plan: Plan }>): Promise<string> => {
    const { text, plan } = await preview;
    const dry = ctx.config.dryRun ? '\nDRY RUN is on (OSWIKI_DRY_RUN=1): execute will only report, nothing is signed or sent.' : '';
    const summary = `${text}${dry}`;
    const confirmId = store.create(plan, summary);
    return `${summary}\n${modeNote()}\n${CONFIRM_FOOTER(confirmId)}`;
  };

  const requireHuman = async (summary: string): Promise<void> => {
    const confirmer = handler.confirmer;
    if (confirmer.available()) {
      let decision: HumanDecision;
      try {
        decision = await confirmer.ask(`oswiki-sign (your local signer, not the AI) asks you to approve this trade:\n\n${summary}`);
      } catch (err) {
        throw new ConfirmError(`The confirmation dialog failed (${errorText(err)}). Nothing was signed or sent.`);
      }
      if (decision !== 'confirmed') throw new ConfirmError('The user did not approve the trade in the confirmation dialog. Nothing was signed or sent. Do not retry unless the user asks again.');
      return;
    }
    if (ctx.config.confirmMode === 'ai') return;
    throw new ConfirmError(NO_DIALOG_REFUSAL);
  };

  const execute = async (confirmId: string): Promise<string> => {
    const { plan, summary } = store.takeConfirmed(confirmId);
    if (ctx.config.dryRun) return `DRY RUN (OSWIKI_DRY_RUN=1): the ${plan.kind} plan was checked and nothing was signed or sent.`;
    const charge = chargeOf(plan);
    const limits = limitsOf(ctx.config);
    ctx.state.check(charge, limits);
    await assertNoPendingTx(ctx.chains, ctx.account, plan.chainId, ctx.now);
    await requireHuman(summary);
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      ctx.state.record(charge, limits);
    };
    switch (plan.kind) {
      case 'listing': return executeListing(ctx, plan, commit);
      case 'buy': return executeBuy(ctx, plan, commit);
      case 'cancel': return executeCancel(ctx, plan, commit);
      case 'offer': return executeOffer(ctx, plan, commit);
      case 'accept': return executeAcceptOffer(ctx, plan, commit);
    }
  };

  const run = async (name: ToolName, args: never): Promise<string> => {
    switch (name) {
      case 'wallet_status': return walletStatus(ctx, { dialog: handler.confirmer.available() });
      case 'my_listings': return myListings(ctx, args);
      case 'my_offers': return myOffers(ctx, args);
      case 'preview_listing': return withConfirm(previewListing(ctx, args));
      case 'preview_buy': return withConfirm(previewBuy(ctx, args));
      case 'preview_cancel': return withConfirm(previewCancel(ctx, args));
      case 'preview_offer': return withConfirm(previewOffer(ctx, args));
      case 'preview_accept_offer': return withConfirm(previewAcceptOffer(ctx, args));
      case 'execute': return serial(() => execute((args as { confirmId: string }).confirmId));
    }
  };

  const handler = (async (name: string, args: unknown): Promise<ToolResult> => {
    try {
      if (!Object.hasOwn(SCHEMAS, name)) throw new Error(`Unknown tool ${name.slice(0, 60)}`);
      const parsed = SCHEMAS[name as ToolName].safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
        throw new Error(`Invalid input: ${issues}`);
      }
      const text = await run(name as ToolName, parsed.data as never);
      return { content: [{ type: 'text', text: scrub(text) }] };
    } catch (err) {
      const prefix = err instanceof ConfirmError ? '' : 'Error: ';
      return { content: [{ type: 'text', text: scrub(`${prefix}${errorText(err)}`) }], isError: true };
    }
  }) as ToolHandler;
  handler.store = store;
  handler.confirmer = options.confirmer ?? NO_HUMAN_CONFIRMER;
  return handler;
}

export function toolDefinitions() {
  return (Object.keys(SCHEMAS) as ToolName[]).map(name => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(SCHEMAS[name]) as Record<string, unknown>;
    const definition = { name, description: DESCRIPTIONS[name], inputSchema: inputSchema as { type: 'object'; [key: string]: unknown } };
    return name === 'execute' ? { ...definition, _meta: { 'anthropic/requiresUserInteraction': true } } : definition;
  });
}

/** The dialog is wired to this server's client; a handler used without a server never gets a human confirmer. */
export function createSignServer(handler: ToolHandler): Server {
  const server = new Server({ name: 'oswiki-sign', version: VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  handler.confirmer = elicitationConfirmer(server);
  const tools = toolDefinitions();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => handler(request.params.name, request.params.arguments));
  return server;
}
