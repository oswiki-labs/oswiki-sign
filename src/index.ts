#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ApiClient } from './api.js';
import { createChains } from './chain.js';
import { loadConfig, SetupError } from './config.js';
import { walletStatus } from './flows/status.js';
import { loadWallet } from './secret.js';
import { createSignServer, createToolHandler } from './server.js';
import { defaultSetupDeps, runSetup } from './setup.js';
import { TradeState } from './state.js';
import { VERSION } from './version.js';

const HELP = `oswiki-sign ${VERSION} - local OSWiki trading signer (MCP server over stdio)

Usage:
  oswiki-sign            start the MCP server (configure it in Claude Desktop, Cursor or Claude Code)
  oswiki-sign setup      interactive setup: wallet, limits, AI client (see oswiki-sign setup --help)
  oswiki-sign status     print the wallet, balances and limits, then exit
  oswiki-sign --version

Environment: OSWIKI_WALLET_KEY_FILE or OSWIKI_WALLET_KEY (one required), OSWIKI_API_KEY, OSWIKI_RPC_URL_MAINNET,
OSWIKI_RPC_URL_APECHAIN, OSWIKI_MAX_BUY_ETH, OSWIKI_MAX_BUY_APE, OSWIKI_DAILY_MAX_ETH, OSWIKI_DAILY_MAX_APE,
OSWIKI_MIN_LIST_FLOOR_PCT (50), OSWIKI_MAX_TRADES_PER_DAY (50), OSWIKI_MAX_CANCELS_PER_DAY (200),
OSWIKI_MAX_GWEI (200), OSWIKI_MAX_GWEI_APECHAIN (1000), OSWIKI_ALLOWED_COLLECTIONS, OSWIKI_CONFIRM_MODE (human),
OSWIKI_DRY_RUN=1. See the README.`;

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === '--version' || arg === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (arg === 'setup') {
    process.exitCode = await runSetup(process.argv.slice(3), defaultSetupDeps(VERSION));
    return;
  }
  if (arg !== undefined && arg !== 'status') {
    process.stderr.write(`Unknown argument. ${HELP}\n`);
    process.exitCode = 1;
    return;
  }

  let wallet;
  let config;
  try {
    wallet = loadWallet(process.env);
    config = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof SetupError ? err.message : 'oswiki-sign could not start.'}\n`);
    process.exitCode = 1;
    return;
  }

  for (const warning of wallet.warnings) process.stderr.write(`${warning}\n`);
  if (config.confirmMode === 'ai') process.stderr.write('WARNING: OSWIKI_CONFIRM_MODE=ai - without a client confirmation dialog, execute runs on the AI\'s word alone.\n');

  const state = new TradeState(config.stateDir, config.maxTradesPerDay, Date.now, { macKey: wallet.stateKey });
  const ctx = {
    config,
    account: wallet.account,
    api: new ApiClient({ apiKey: config.apiKey }),
    chains: createChains(config, wallet.account, { tracker: state }),
    state,
    now: Date.now,
  };

  if (arg === 'status') {
    process.stdout.write(`${wallet.scrub(await walletStatus(ctx))}\n`);
    return;
  }

  const server = createSignServer(createToolHandler(ctx, wallet.scrub));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`oswiki-sign ${VERSION} ready for ${wallet.account.address}${config.dryRun ? ' (dry run)' : ''}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`oswiki-sign stopped: ${err instanceof Error ? err.name : 'error'}\n`);
  process.exitCode = 1;
});
