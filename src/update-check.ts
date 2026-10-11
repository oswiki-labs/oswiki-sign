import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LATEST_URL = 'https://registry.npmjs.org/@oswikixyz/sign/latest';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 3000;
export const UPDATE_COMMAND = 'npx -y @oswikixyz/sign@latest update';

const SEMVER_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

export type RegistryFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface UpdateCheckOptions {
  stateDir: string;
  version: string;
  env: NodeJS.ProcessEnv;
  fetch?: RegistryFetch;
  now?: () => number;
  timeoutMs?: number;
}

interface Cache {
  checkedAt: number;
  latest: string | null;
}

export function compareVersions(a: string, b: string): number | null {
  const left = SEMVER_RE.exec(a);
  const right = SEMVER_RE.exec(b);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function updateCheckEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OSWIKI_UPDATE_CHECK?.trim() !== '0';
}

function cacheFile(stateDir: string): string {
  return join(stateDir, 'update-check.json');
}

function readCache(stateDir: string): Cache | null {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(stateDir), 'utf8')) as Partial<Cache>;
    if (typeof parsed.checkedAt !== 'number' || !Number.isFinite(parsed.checkedAt)) return null;
    const latest = typeof parsed.latest === 'string' && SEMVER_RE.test(parsed.latest) ? parsed.latest : null;
    return { checkedAt: parsed.checkedAt, latest };
  } catch {
    return null;
  }
}

function writeCache(stateDir: string, cache: Cache): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = cacheFile(stateDir);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch {
    return;
  }
}

function newer(latest: string | null, version: string): string | null {
  return latest !== null && compareVersions(latest, version) === 1 ? latest : null;
}

/** Cache only, never the network. */
export function cachedUpdate(options: Pick<UpdateCheckOptions, 'stateDir' | 'version' | 'env'>): string | null {
  if (!updateCheckEnabled(options.env)) return null;
  return newer(readCache(options.stateDir)?.latest ?? null, options.version);
}

/** Newer published version, or null. Hits the registry at most once per 24h, failed attempts included; never throws. */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | null> {
  if (!updateCheckEnabled(options.env)) return null;
  const now = (options.now ?? Date.now)();
  const cache = readCache(options.stateDir);
  if (cache && now - cache.checkedAt >= 0 && now - cache.checkedAt < CHECK_INTERVAL_MS) return newer(cache.latest, options.version);
  let latest = cache?.latest ?? null;
  try {
    const fetcher = options.fetch ?? (globalThis.fetch as unknown as RegistryFetch);
    const response = await fetcher(LATEST_URL, { signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (response.ok) {
      const body = await response.json() as { version?: unknown } | null;
      if (typeof body?.version === 'string' && SEMVER_RE.test(body.version)) latest = body.version;
    }
  } catch {
    latest = cache?.latest ?? null;
  }
  writeCache(options.stateDir, { checkedAt: now, latest });
  return newer(latest, options.version);
}

export function updateNotice(latest: string, version: string): string {
  return `Update available: ${latest} (you run ${version}). In a terminal: ${UPDATE_COMMAND}, then restart the app.`;
}
