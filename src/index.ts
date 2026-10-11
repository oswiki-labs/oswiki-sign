#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ApiClient } from './api.js';
import { createChains } from './chain.js';
import { SetupError } from './config.js';
import { walletStatus } from './flows/status.js';
import { loadWallet } from './secret.js';
import { createSignServer, createToolHandler } from './server.js';
import { SettingsStore } from './settings.js';
import { defaultSetupDeps, runSetup, runUpdate } from './setup.js';
import { TradeState } from './state.js';
import { checkForUpdate, updateNotice } from './update-check.js';
import { VERSION } from './version.js';

const HELP = `oswiki-sign ${VERSION} - local OSWiki trading signer (MCP server over stdio)

Usage:
  oswiki-sign            start the MCP server (configure it in Claude Desktop, Cursor or Claude Code)
  oswiki-sign setup      interactive setup: wallet, limits, AI client (npx -y @oswikixyz/sign setup)
  oswiki-sign update     move every configured app to this version (npx -y @oswikixyz/sign@latest update)
  oswiki-sign status     print the wallet, balances and limits, then exit
  oswiki-sign --version

Environment: OSWIKI_WALLET_KEY_FILE (required; the key itself is never accepted inline), OSWIKI_API_KEY,
OSWIKI_RPC_URL_MAINNET, OSWIKI_RPC_URL_APECHAIN, OSWIKI_MAX_BUY_ETH, OSWIKI_MAX_BUY_APE, OSWIKI_DAILY_MAX_ETH,
OSWIKI_DAILY_MAX_APE, OSWIKI_DAILY_MAX_SELL_ETH, OSWIKI_DAILY_MAX_SELL_APE, OSWIKI_DAILY_MAX_BELOW_FLOOR_ETH,
OSWIKI_DAILY_MAX_BELOW_FLOOR_APE, OSWIKI_DAILY_MAX_SEND_ETH, OSWIKI_DAILY_MAX_SEND_APE,
OSWIKI_MIN_LIST_FLOOR_PCT (50), OSWIKI_MAX_TRADES_PER_DAY (50), OSWIKI_MAX_CANCELS_PER_DAY (200),
OSWIKI_MAX_GWEI (200), OSWIKI_MAX_GWEI_APECHAIN (1000), OSWIKI_ALLOWED_COLLECTIONS, OSWIKI_BLOCKED_COLLECTIONS, OSWIKI_TRUSTED_COLLECTIONS,
OSWIKI_CONFIRM_MODE (human|ai|off), OSWIKI_BROWSER_APPROVAL=0, OSWIKI_DRY_RUN=1, OSWIKI_UPDATE_CHECK=0. Limits changed from the chat (update_limits) are kept in
~/.oswiki-sign/settings.json and override these. See the README.`;

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
  if (arg === 'update') {
    process.exitCode = await runUpdate(process.argv.slice(3), defaultSetupDeps(VERSION));
    return;
  }
  if (arg !== undefined && arg !== 'status') {
    process.stderr.write(`Unknown argument. ${HELP}\n`);
    process.exitCode = 1;
    return;
  }

  let wallet;
  let config;
  let settings;
  try {
    wallet = loadWallet(process.env);
    settings = SettingsStore.fromEnv(process.env, wallet.stateKey);
    config = settings.load();
  } catch (err) {
    process.stderr.write(`${err instanceof SetupError ? err.message : 'oswiki-sign could not start.'}\n`);
    process.exitCode = 1;
    return;
  }

  for (const warning of wallet.warnings) process.stderr.write(`${warning}\n`);
  if (settings.warning) process.stderr.write(`${settings.warning}\n`);
  if (config.confirmMode === 'off') process.stderr.write('WARNING: OSWIKI_CONFIRM_MODE=off - oswiki-sign shows no confirmation dialog; trades run on the AI\'s word, and a manipulated text could trigger a trade within your limits.\n');
  if (config.confirmMode === 'ai') process.stderr.write('WARNING: OSWIKI_CONFIRM_MODE=ai - without a client confirmation dialog and with OSWIKI_BROWSER_APPROVAL=0, execute runs on the AI\'s word alone.\n');

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
    process.stdout.write(`${wallet.scrub(await walletStatus(ctx, { overrides: settings.overrides, settingsWarning: settings.warning }))}\n`);
    return;
  }

  const server = createSignServer(createToolHandler(ctx, wallet.scrub, { settings }));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`oswiki-sign ${VERSION} ready for ${wallet.account.address}${config.dryRun ? ' (dry run)' : ''}\n`);
  void checkForUpdate({ stateDir: config.stateDir, version: VERSION, env: process.env }).then((latest) => {
    if (latest) process.stderr.write(`${updateNotice(latest, VERSION)}\n`);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`oswiki-sign stopped: ${err instanceof Error ? err.name : 'error'}\n`);
  process.exitCode = 1;
});
