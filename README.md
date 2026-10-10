# oswiki-sign

Local trading signer for [OSWiki](https://oswiki.xyz). It is a small MCP server that runs on your own machine, next to Claude Desktop, Cursor or Claude Code, and lets the AI list, buy, cancel, make offers and accept offers for you on Ethereum and ApeChain (Seaport 1.6).

The private key stays on your machine. The AI never sees it, the hosted OSWiki MCP never sees it, and the OSWiki API never sees it. Every order and transaction is built and checked locally against the chain before anything is signed.

## Quick setup

```sh
npx -y @oswikixyz/sign@0.1.1 setup
```

Run it in a terminal (Node.js 20 or newer). It asks a few questions and then:

1. creates a new trading wallet (recommended) or imports an existing private key at a hidden prompt, and stores the key in `~/.oswiki-sign/key` (Windows: `%USERPROFILE%\.oswiki-sign\key`), readable only by you. A new wallet's address is shown so you can fund it; the key itself is only shown if you ask to see it once for a backup.
2. sets the limits: max buy per chain (or buys and offers off), the minimum % of the floor for listings, trades per day, and dry run (on by default).
3. adds oswiki-sign to Claude Code (`claude mcp add --scope user`), Cursor (`~/.cursor/mcp.json`) or Claude Desktop (`claude_desktop_config.json`), or prints the config for you to copy. The config holds only the path of the key file, never the key, and always the exact version.
4. for Claude Code, adds the [hardening](#claude-code-hardening) deny rules to `~/.claude/settings.json`.

Every file it changes is backed up first (`<file>.bak-<time>`), other MCP servers and settings are kept, and an existing key file is only replaced if you confirm it (it is then moved to `key.bak-<time>`). Run setup again to change the limits or turn dry run off; it keeps your wallet. `npx -y @oswikixyz/sign@0.1.1 setup --help` shows the details. To do everything by hand instead, see [Manual setup](#manual-setup).

## How it works

1. The AI calls a `preview_*` tool. oswiki-sign reads the chain and the OSWiki `/v1` API, builds the exact order or transaction, runs every safety check and returns a preview: price, fees, royalty, payout, approvals, warnings.
2. You read the preview and tell the AI to go ahead.
3. The AI calls `execute` with the `confirmId` from that preview. oswiki-sign re-checks the counter, ownership and a simulation, then signs and sends exactly what was previewed. A `confirmId` works once and expires after 10 minutes.

Tools: `wallet_status`, `my_listings`, `my_offers`, `preview_listing`, `preview_buy`, `preview_cancel`, `preview_offer`, `preview_accept_offer`, `execute`.

`preview_cancel` takes `askIds` (your OSWiki listings, including their linked OpenSea listings), `bidIds` (your offers) and `orders`: the order components of signed orders the OSWiki API rejected, exactly as an `execute` result printed them, so they can still be cancelled on-chain.

### Confirmation dialog

When the AI calls `execute`, oswiki-sign itself opens a confirmation dialog in your client showing the exact trade. Only ticking "Sign and send this trade" sends it; the AI cannot answer this dialog. Claude Code shows the dialog automatically. If your client cannot show it, trades are refused unless you set `OSWIKI_CONFIRM_MODE=ai` (less safe: the AI's word then counts as your confirmation).

### Royalties

When the collection has on-chain ERC-2981 royalty info, the royalty in a preview is checked against it. When it does not, the royalty comes only from the OSWiki API, the preview labels it `UNVERIFIED (from OSWiki API, collection has no on-chain royalty info)`, and oswiki-sign refuses to pay more than 10% on such a collection.

## Before you start

- **Use a separate trading wallet.** Create a fresh wallet for oswiki-sign and fund it only with what you are willing to trade. Never use your main wallet or one that holds anything you do not plan to trade.
- **Dry run first.** Start with `OSWIKI_DRY_RUN=1`: previews work, `execute` signs and sends nothing. Try a listing, an offer and a buy, read the previews, then turn dry run off.
- **Set the limits.** Buys and offers stay off on a chain until its max-buy limit is set.
- **Keep the hosted OSWiki MCP** (`https://mcp.oswiki.xyz/mcp`) installed as well: it is where the AI looks up collections, floors, listings and sales. oswiki-sign only trades.

## Manual setup

[Quick setup](#quick-setup) does all of this for you. oswiki-sign is published on npm as [`@oswikixyz/sign`](https://www.npmjs.com/package/@oswikixyz/sign). It needs Node.js 20 or newer. Always pin the exact version (`@oswikixyz/sign@0.1.1`), never `latest` or a range, and update only on purpose.

### 1. Store the key in a file

oswiki-sign reads the private key from a file (`OSWIKI_WALLET_KEY_FILE`). Never put the key itself in a config file, an environment variable or a command line.

macOS / Linux (the key is typed at a hidden prompt, so it never lands in your shell history):

```sh
mkdir -p ~/.oswiki-sign && chmod 700 ~/.oswiki-sign
(umask 077; printf 'Private key: '; IFS= read -rs k; printf '%s\n' "$k" > ~/.oswiki-sign/key; unset k; echo)
```

Windows (PowerShell; the file is readable by your user only):

```powershell
$d = "$env:USERPROFILE\.oswiki-sign"; New-Item -ItemType Directory -Force $d | Out-Null
$k = Read-Host 'Private key' -AsSecureString
[IO.File]::WriteAllText("$d\key", [Net.NetworkCredential]::new('', $k).Password); Remove-Variable k
icacls "$d\key" /inheritance:r /grant:r "${env:USERNAME}:R" | Out-Null
```

Why a file: a key in the MCP config's `env` block (or in your shell environment) sits in plain text in a file your AI client can read, and while oswiki-sign runs it is visible to every process of the same user (`/proc/<pid>/environ` on Linux, `ps eww` on macOS). With a key file only the path is in the environment; oswiki-sign reads the file once at start.

Use the absolute path of the key file below (Windows: `"C:\\Users\\you\\.oswiki-sign\\key"` in JSON).

### 2. Add it to your AI client

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "oswiki-sign": {
      "command": "npx",
      "args": ["-y", "@oswikixyz/sign@0.1.1"],
      "env": {
        "OSWIKI_WALLET_KEY_FILE": "/Users/you/.oswiki-sign/key",
        "OSWIKI_DRY_RUN": "1",
        "OSWIKI_MAX_BUY_ETH": "0.5",
        "OSWIKI_MAX_BUY_APE": "500"
      }
    }
  }
}
```

If your client on Windows cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@oswikixyz/sign@0.1.1"]`.

Claude Code (user scope, so it is stored in `~/.claude.json` and not in a project):

```sh
claude mcp add --scope user oswiki-sign \
  -e OSWIKI_WALLET_KEY_FILE=/Users/you/.oswiki-sign/key \
  -e OSWIKI_DRY_RUN=1 \
  -e OSWIKI_MAX_BUY_ETH=0.5 \
  -e OSWIKI_MAX_BUY_APE=500 \
  -- npx -y @oswikixyz/sign@0.1.1
```

On native Windows, Claude Code needs `cmd /c` to start `npx`: end the command with `-- cmd /c npx -y @oswikixyz/sign@0.1.1`.

Check the setup from a terminal with the same environment variables set:

```sh
npx -y @oswikixyz/sign@0.1.1 status
```

When the dry-run previews look right, remove `OSWIKI_DRY_RUN` (or set it to `0`) and restart the client.

### Claude Code hardening

oswiki-sign's limits and its confirmation dialog only help if the agent cannot quietly change its own setup. Put this in your user settings (`~/.claude/settings.json`) so it applies to every project:

```json
{
  "permissions": {
    "deny": [
      "Read(~/.oswiki-sign/**)",
      "Edit(~/.oswiki-sign/**)",
      "Read(~/.claude.json)",
      "Edit(~/.claude.json)",
      "Edit(~/.claude/settings.json)",
      "Edit(~/.claude/settings.local.json)",
      "Edit(//**/.claude/settings.json)",
      "Edit(//**/.claude/settings.local.json)",
      "Edit(//**/.mcp.json)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead": ["~/.oswiki-sign"],
      "denyWrite": ["~/.oswiki-sign"]
    }
  }
}
```

- `~/` is your home directory and `//` the filesystem root, so the `//**/` rules match a project's `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` in any folder (on Windows across all drives). A single leading `/` would mean the folder of the settings file, not the root.
- Blocking edits to Claude Code's settings and MCP files stops an agent from adding an `Elicitation` hook that auto-answers the confirmation dialog, switching `OSWIKI_CONFIRM_MODE`, raising the limits or swapping the server. Blocking `~/.oswiki-sign` keeps the key file and the daily counters out of reach.
- Permission rules cover Claude's file tools and the shell commands Claude Code recognizes (`cat`, `head`, `sed`, `tee`, redirections), not a script that opens files itself (for example `node -e` or `python -c`). The sandbox closes that gap at the OS level for every shell command and its child processes, so keep it on (default above; `/sandbox` shows its state). It runs on macOS, Linux and WSL2; on native Windows Claude Code runs commands unsandboxed, so run Claude Code inside WSL2 if you trade with it on Windows.
- `allowUnsandboxedCommands: false` stops Claude from retrying a blocked command outside the sandbox.

Cursor, Claude Desktop and other clients have their own settings; the same idea applies: the agent must not be able to read the key file or edit the MCP config.

## Verify the package

Every release is built and published by the [release workflow](.github/workflows/release.yml) of this repository with npm provenance, from a `v*` tag on `main`. No release is built on a personal machine.

- The package page on [npmjs.com](https://www.npmjs.com/package/@oswikixyz/sign) shows a provenance badge linking to the exact commit and workflow run.
- `npm audit signatures` in a project that installed `@oswikixyz/sign@<version>` checks the registry signature and the provenance attestation.
- The package has no runtime dependencies and no install scripts: everything is bundled into `dist/index.js`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `OSWIKI_WALLET_KEY_FILE` | required | Path to a file holding only the private key of the trading wallet (`0x` + 64 hex). Read once at start; the variable is then removed from the environment. On macOS/Linux keep it at mode 600 (oswiki-sign warns otherwise). |
| `OSWIKI_WALLET_KEY` | - | Not recommended: the key itself instead of `OSWIKI_WALLET_KEY_FILE` (set only one). It then sits in plain text in your client config and in the process environment. |
| `OSWIKI_DRY_RUN` | off | `1`: previews work, `execute` signs and sends nothing. Start with this. |
| `OSWIKI_MAX_BUY_ETH` | required for buys/offers | Most one buy or offer may spend on Ethereum, in ETH. Without it, buying and offers on Ethereum are off (listing and cancelling still work). |
| `OSWIKI_MAX_BUY_APE` | required for buys/offers | Same on ApeChain, in APE. |
| `OSWIKI_MIN_LIST_FLOOR_PCT` | 50 | Listings and accepted offers below this % of the collection floor are refused. `0` turns it off. |
| `OSWIKI_MAX_TRADES_PER_DAY` | 50 | Listed, bought, offered and accepted items per UTC day (every item of a bulk execute counts). Counted in `~/.oswiki-sign/state.json`. |
| `OSWIKI_ALLOWED_COLLECTIONS` | any | Comma-separated collection addresses; everything else is refused. See [Otherdeed](#otherdeed-has-two-contracts). |
| `OSWIKI_API_KEY` | none | Your oswiki.xyz API key (Account, Developer) for your own rate limit. |
| `OSWIKI_RPC_URL_MAINNET` | `https://ethereum-rpc.publicnode.com` | Ethereum RPC (https). |
| `OSWIKI_RPC_URL_APECHAIN` | `https://rpc.apechain.com/http` | ApeChain RPC (https). |
| `OSWIKI_CONFIRM_MODE` | `human` | `human`: every `execute` must be approved by you in oswiki-sign's own confirmation dialog; clients without that dialog cannot execute. `ai`: on clients without the dialog, the AI's word counts as your confirmation. Less safe; previews and `wallet_status` say so loudly. |
| `OSWIKI_DAILY_MAX_ETH` | 3x `OSWIKI_MAX_BUY_ETH` | Total ETH that buys plus new offers may use per UTC day on Ethereum. |
| `OSWIKI_DAILY_MAX_APE` | 3x `OSWIKI_MAX_BUY_APE` | Same on ApeChain, in APE. |
| `OSWIKI_MAX_CANCELS_PER_DAY` | 200 | Cancelled orders per UTC day (each order counts). |
| `OSWIKI_MAX_GWEI` | 200 | Highest max fee per gas on Ethereum; transactions are refused above it. |
| `OSWIKI_MAX_GWEI_APECHAIN` | 1000 | Same on ApeChain. |

## Otherdeed has two contracts

Otherdeeds live in two collections on Ethereum:

| Collection | Address |
|---|---|
| Otherdeed | `0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258` |
| Otherdeed Expanded | `0x790b2cf29ed4f310bf7641f013c65d4560d28371` |

If you restrict trading with `OSWIKI_ALLOWED_COLLECTIONS` and want to trade Otherdeeds, list both:

```
OSWIKI_ALLOWED_COLLECTIONS=0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258,0x790b2cf29ed4f310bf7641f013c65d4560d28371
```

## Safety

- **Separate wallet.** Fund it with what you plan to trade, nothing more.
- **Key file, not the key.** Use `OSWIKI_WALLET_KEY_FILE` and keep the agent away from `~/.oswiki-sign` and its own config (see [Claude Code hardening](#claude-code-hardening)).
- **Set the max-buy limits.** Buys and offers stay off on a chain until its `OSWIKI_MAX_BUY_*` is set; pick the most you would ever spend in one trade.
- **Dry run first.** Try a listing, an offer and a buy with `OSWIKI_DRY_RUN=1` and read the previews before you turn it off.
- **Never paste the key into a chat.** oswiki-sign never asks for it, and the AI must not either.
- **Read every preview.** Nothing happens until you approve the trade in the confirmation dialog.
- **Pin the exact version.** Never run an unpinned or "latest" oswiki-sign.
- What oswiki-sign enforces in code, whatever the AI or the API say:
  - only Seaport 1.6 and the OpenSea conduit; fee exactly 1% to the known OSWiki fee recipient of the chain; royalty at most 25%, and at most 10% when it is unverified;
  - approvals only to the OpenSea conduit (your NFTs) and to Seaport for WETH/WAPE, for the exact amount, never unlimited;
  - transactions only to Seaport, WETH/WAPE, or `setApprovalForAll` on the collection being traded;
  - the Seaport counter is always read from the chain (never assumed), purchases are re-encoded locally and must match the listing's own hash and exact price, and every transaction is simulated first;
  - prices are explicit numbers: no listing at 0, no guessed floor;
  - every `execute` needs your confirmation in oswiki-sign's own dialog (unless you chose `OSWIKI_CONFIRM_MODE=ai`);
  - the limits above, daily value caps per chain, gas limit and fee caps per transaction, and no resend while an earlier transaction may still land;
  - the daily counters are signed with a key derived from your wallet key, so editing `state.json` cannot raise them.

  The limits are local to your machine: anything that can write files as your user (including an agent with shell access) can reset them by deleting `~/.oswiki-sign/state.json`, or change them in the MCP config. That is why the [Claude Code hardening](#claude-code-hardening) deny rules and the sandbox matter; the per-trade caps (`OSWIKI_MAX_BUY_*`) and the separate wallet are what bound the worst case.

Report security issues privately to office@oswiki.xyz, not in a public issue.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build        # esbuild bundle into dist/index.js
npm run check:pack   # the package may contain only package.json, README.md, LICENSE, dist/index.js
npm run test:bundle  # runs the bundle without node_modules
```

`tests/fixtures/seaport-vectors.json` holds the Seaport test vectors shared with the OSWiki website and backend; it must not be edited by hand.

## Releasing

1. Bump `version` in `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`), merge to `main`.
2. Tag that commit on `main` and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
3. The release workflow checks that the tag equals `v` + the `package.json` version and that the commit is on `main`, runs all checks, then stages the version on npm with provenance (`npm stage publish`) through npm trusted publishing (no npm token is stored anywhere). The trusted publisher only allows staging, so nothing goes live from CI alone.
4. A maintainer approves the staged version with 2FA, in the **Staged Packages** tab on [npmjs.com](https://www.npmjs.com) or with `npm stage approve <stage-id>`. Only then is it live. The job summary links the steps. A reviewer on the GitHub `npm` environment is optional, as an extra gate before the workflow runs.
5. Update the pinned version in the install snippets and on the OSWiki developer docs.

## License

[MIT](LICENSE)
