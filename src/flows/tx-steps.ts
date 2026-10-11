import { sanitizeServerText } from '../api.js';
import { UnconfirmedTxError } from '../chain.js';
import { RejectedOrderError } from './common.js';

/** Built only from our own text and sanitized error text, and must reach the AI whole. */
export class TradeStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeStoppedError';
  }
}

const RETRY_RULE = 'Tell the user exactly which transactions went out; do not retry them. Run the preview again for the rest if they still want it.';

function reasonOf(err: unknown, sentBefore: boolean): string {
  const message = typeof (err as { message?: unknown } | null)?.message === 'string' ? (err as Error).message : '';
  const text = sanitizeServerText(message, 400) || 'unknown error';
  return sentBefore ? text.replace(/Nothing was (signed or )?sent\.?/g, 'This step was not sent.').trim() : text;
}

/**
 * One on-chain step of a multi-step trade. `log` holds a line (with its tx hash) for every earlier
 * step that went out, so a failure here never reads as "nothing was sent" when something was.
 */
export async function txStep<T>(log: string[], label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const unconfirmed = err instanceof UnconfirmedTxError;
    if (log.length === 0 && !unconfirmed) throw err;
    throw new TradeStoppedError([
      log.length > 0 ? 'Stopped part-way. These transactions already went out:' : `${label}: sent but not confirmed.`,
      ...log.map(line => `- ${line}`),
      unconfirmed ? `- ${label}: ${(err as Error).message}` : `- ${label}: FAILED (${reasonOf(err, true)})`,
      'Nothing after this step was signed or sent.',
      RETRY_RULE,
    ].join('\n'));
  }
}

/** A failure after some transactions already went out (signing, a re-check, the API) keeps their record. */
export function afterSends(log: string[], err: unknown): unknown {
  if (log.length === 0 || err instanceof TradeStoppedError || err instanceof RejectedOrderError) return err;
  return new TradeStoppedError([
    'Stopped part-way. These transactions already went out:',
    ...log.map(line => `- ${line}`),
    `Then: ${reasonOf(err, true)}`,
    RETRY_RULE,
  ].join('\n'));
}
