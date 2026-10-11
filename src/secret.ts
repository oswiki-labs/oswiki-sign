import { createHash, createHmac } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { SetupError } from './config.js';
import { VERSION } from './version.js';

const KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
const HEX_RUN_RE = /[0-9a-fA-F]{64,}/g;
const MAX_KEY_FILE_BYTES = 1024;

export const SETUP_MESSAGE = [
  'oswiki-sign needs a key file: set OSWIKI_WALLET_KEY_FILE to the path of a file that holds the private key (0x followed by 64 hex characters).',
  `The easiest way is to run \`npx -y @oswikixyz/sign@${VERSION} setup\` in a terminal. Use a separate trading wallet that only holds what you are willing to trade.`,
  'Never paste the key into a chat: the AI must never see it.',
].join('\n');

export const INLINE_KEY_MESSAGE = [
  'oswiki-sign no longer accepts the private key inline in OSWIKI_WALLET_KEY: in the MCP config and the process environment it is readable in plain text. Nothing was started.',
  `Move it to a key file: run \`npx -y @oswikixyz/sign@${VERSION} setup\` in a terminal and choose "Import key" (it stores the key in ~/.oswiki-sign/key and writes a config with only the file path),`,
  'or save the key in a file yourself (README, Manual setup), set OSWIKI_WALLET_KEY_FILE to its path and delete OSWIKI_WALLET_KEY from the config. Then restart the AI client.',
].join('\n');

function fingerprint(hex64: string): string {
  return createHash('sha256').update(hex64.toLowerCase()).digest('hex');
}

export type Scrubber = (text: string) => string;

/**
 * Only a hash of the key is kept for scrubbing, so the scrubber itself never holds it.
 * Every 64-hex window of every hex run is compared, which also catches a key inside longer blobs.
 */
export function createScrubber(keyFingerprint: string): Scrubber {
  return (text: string) => text.replace(HEX_RUN_RE, (run) => {
    for (let i = 0; i + 64 <= run.length; i++) {
      if (fingerprint(run.slice(i, i + 64)) === keyFingerprint) return '[redacted]';
    }
    return run;
  });
}

export interface LoadedWallet {
  account: PrivateKeyAccount;
  scrub: Scrubber;
  stateKey: Buffer;
  warnings: string[];
}

function readKeyFile(path: string, platform: NodeJS.Platform): { raw: string; warnings: string[] } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new SetupError('OSWIKI_WALLET_KEY_FILE could not be opened. Check the path.');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SetupError('OSWIKI_WALLET_KEY_FILE must point to a regular file.');
    if (stat.size > MAX_KEY_FILE_BYTES) throw new SetupError('OSWIKI_WALLET_KEY_FILE is too large to be a key file.');
    const warnings: string[] = [];
    if (platform === 'win32') {
      warnings.push('Warning: on Windows oswiki-sign cannot check who may read the key file (file modes do not reflect Windows permissions). Keep it in a folder only your Windows user can open, e.g. under %USERPROFILE%, never in a shared, synced (OneDrive/Dropbox) or public folder.');
    } else if ((stat.mode & 0o077) !== 0) {
      warnings.push(`Warning: the key file is readable by other users (mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 "${path}"`);
    }
    const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, length).toString('utf8').replace(/^﻿/, '');
    buffer.fill(0);
    return { raw, warnings };
  } finally {
    closeSync(fd);
  }
}

/** Reads the key once and removes it from the environment so nothing later (or any child process) can read it. */
export function loadWallet(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): LoadedWallet {
  const inline = env.OSWIKI_WALLET_KEY;
  const file = env.OSWIKI_WALLET_KEY_FILE;
  delete env.OSWIKI_WALLET_KEY;
  delete env.OSWIKI_WALLET_KEY_FILE;
  if (inline !== undefined && inline.trim() !== '') throw new SetupError(INLINE_KEY_MESSAGE);
  if (file === undefined || file.trim() === '') throw new SetupError(SETUP_MESSAGE);

  const source = 'OSWIKI_WALLET_KEY_FILE';
  const { raw, warnings } = readKeyFile(file.trim(), platform);
  const trimmed = raw.trim();
  if (!KEY_RE.test(trimmed)) {
    throw new SetupError(`${source} does not hold a valid private key: it must be 0x followed by 64 hex characters.`);
  }
  const hex = (trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed).toLowerCase();
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(`0x${hex}`);
  } catch {
    throw new SetupError(`${source} does not hold a valid secp256k1 private key.`);
  }
  const stateKey = createHmac('sha256', Buffer.from(hex, 'hex')).update('oswiki-sign/state-mac/v1').digest();
  return { account, scrub: createScrubber(fingerprint(hex)), stateKey, warnings };
}
