import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type Config } from './config.js';
import { atomicWrite, withFileLock } from './state.js';

export const OVERRIDABLE = [
  'OSWIKI_MAX_BUY_ETH',
  'OSWIKI_MAX_BUY_APE',
  'OSWIKI_DAILY_MAX_ETH',
  'OSWIKI_DAILY_MAX_APE',
  'OSWIKI_DAILY_MAX_SEND_ETH',
  'OSWIKI_DAILY_MAX_SEND_APE',
  'OSWIKI_MIN_LIST_FLOOR_PCT',
  'OSWIKI_MAX_TRADES_PER_DAY',
  'OSWIKI_MAX_CANCELS_PER_DAY',
  'OSWIKI_DRY_RUN',
  'OSWIKI_CONFIRM_MODE',
  'OSWIKI_ALLOWED_COLLECTIONS',
  'OSWIKI_BLOCKED_COLLECTIONS',
] as const;

export type OverridableKey = typeof OVERRIDABLE[number];
export type Overrides = Partial<Record<OverridableKey, string>>;

const SETTINGS_VERSION = 1;
const UNKEYED = createHash('sha256').update('oswiki-sign/settings/unkeyed').digest();
const VALUE_RE = /^[0-9A-Za-z.,]{0,8000}$/;

export function settingsMacKey(stateKey: Uint8Array | undefined): Buffer {
  return stateKey ? createHmac('sha256', stateKey).update('oswiki-sign/settings-mac/v1').digest() : UNKEYED;
}

export function settingsFile(stateDir: string): string {
  return join(stateDir, 'settings.json');
}

function body(overrides: Overrides): string {
  const sorted = Object.fromEntries(OVERRIDABLE.filter(key => overrides[key] !== undefined).map(key => [key, overrides[key]]));
  return JSON.stringify({ v: SETTINGS_VERSION, env: sorted });
}

function mac(key: Uint8Array, text: string): string {
  return createHmac('sha256', key).update(text).digest('hex');
}

export type ReadResult = { overrides: Overrides; warning: string | null };

/** A file whose MAC does not verify (edited by hand, or written for another wallet) is ignored, never trusted. */
export function readOverrides(stateDir: string, macKey: Uint8Array): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(settingsFile(stateDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { overrides: {}, warning: null };
    return { overrides: {}, warning: 'WARNING: ~/.oswiki-sign/settings.json could not be read, so the limits changed from the chat are ignored; the setup/env values apply.' };
  }
  const ignored = { overrides: {}, warning: 'WARNING: ~/.oswiki-sign/settings.json failed its integrity check, so the limits changed from the chat are ignored; the setup/env values apply.' };
  let parsed: { v?: unknown; env?: unknown; mac?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return ignored;
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== SETTINGS_VERSION || typeof parsed.mac !== 'string' || parsed.env === null || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return ignored;
  const env = parsed.env as Record<string, unknown>;
  const overrides: Overrides = {};
  for (const [key, value] of Object.entries(env)) {
    if (!(OVERRIDABLE as readonly string[]).includes(key) || typeof value !== 'string' || !VALUE_RE.test(value)) return ignored;
    overrides[key as OverridableKey] = value;
  }
  const expected = Buffer.from(mac(macKey, body(overrides)), 'hex');
  const given = Buffer.from(parsed.mac, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return ignored;
  return { overrides, warning: null };
}

export function writeOverrides(stateDir: string, macKey: Uint8Array, overrides: Overrides): void {
  const text = body(overrides);
  atomicWrite(stateDir, settingsFile(stateDir), `${text.slice(0, -1)},"mac":"${mac(macKey, text)}"}`);
}

export function clearOverrides(stateDir: string): void {
  rmSync(settingsFile(stateDir), { force: true });
}

/** Effective config = env (setup) values overridden by the verified chat changes in settings.json. */
export class SettingsStore {
  private readonly lockFile: string;
  overrides: Overrides = {};
  warning: string | null = null;

  constructor(private readonly baseEnv: NodeJS.ProcessEnv, private readonly stateDir: string, private readonly macKey: Uint8Array) {
    this.lockFile = join(stateDir, 'settings.lock');
  }

  static fromEnv(env: NodeJS.ProcessEnv, stateKey?: Uint8Array): SettingsStore {
    const base = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('OSWIKI_') && key !== 'OSWIKI_WALLET_KEY'));
    return new SettingsStore(base, loadConfig(base).stateDir, settingsMacKey(stateKey));
  }

  /** Loads the env config, then applies the overrides; overrides that no longer parse are dropped with a warning. */
  load(): Config {
    const base = loadConfig(this.baseEnv);
    const read = readOverrides(this.stateDir, this.macKey);
    this.warning = read.warning;
    try {
      const config = loadConfig({ ...this.baseEnv, ...read.overrides });
      this.overrides = read.overrides;
      return config;
    } catch {
      this.overrides = {};
      this.warning = 'WARNING: ~/.oswiki-sign/settings.json holds a value that is no longer valid, so the limits changed from the chat are ignored; the setup/env values apply.';
      return base;
    }
  }

  preview(next: Overrides): Config {
    return loadConfig({ ...this.baseEnv, ...next });
  }

  envValue(key: OverridableKey): string | undefined {
    return this.overrides[key] ?? this.baseEnv[key];
  }

  save(next: Overrides): Config {
    return withFileLock(this.stateDir, this.lockFile, () => {
      const config = this.preview(next);
      writeOverrides(this.stateDir, this.macKey, next);
      this.overrides = next;
      this.warning = null;
      return config;
    });
  }
}

