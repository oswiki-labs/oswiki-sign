import { randomUUID } from 'node:crypto';

export const CONFIRM_TTL_MS = 10 * 60_000;

export class ConfirmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmError';
  }
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'bigint') return `${entry.toString()}n`;
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return entry;
  });
}

interface Entry<T> {
  plan: T;
  summary: string;
  bytes: string;
  expiresAt: number;
}

export interface Confirmed<T> {
  plan: T;
  summary: string;
}

/**
 * confirmIds live in memory only, are single use and expire after 10 minutes. Each one is bound to the
 * serialized bytes of the plan and its preview text at preview time; any later change to either is refused.
 */
export class ConfirmStore<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  create(plan: T, summary = ''): string {
    this.prune();
    const id = randomUUID();
    this.entries.set(id, { plan, summary, bytes: canonical({ plan, summary }), expiresAt: this.now() + CONFIRM_TTL_MS });
    return id;
  }

  take(id: string): T {
    return this.takeConfirmed(id).plan;
  }

  takeConfirmed(id: string): Confirmed<T> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    if (!entry) throw new ConfirmError('Unknown or already used confirmId. Run the preview again.');
    if (this.now() > entry.expiresAt) throw new ConfirmError('This confirmId expired (10 minutes). Run the preview again.');
    if (canonical({ plan: entry.plan, summary: entry.summary }) !== entry.bytes) {
      throw new ConfirmError('The previewed plan changed after the preview. Nothing was signed or sent.');
    }
    return { plan: entry.plan, summary: entry.summary };
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (now > entry.expiresAt) this.entries.delete(id);
  }
}
