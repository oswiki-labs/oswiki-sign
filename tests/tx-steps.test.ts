import { describe, expect, it } from 'vitest';

import { UnconfirmedTxError } from '../src/chain.js';
import { GuardError, RejectedOrderError } from '../src/flows/common.js';
import { afterSends, TradeStoppedError, txStep } from '../src/flows/tx-steps.js';
import { errorText } from '../src/server.js';

const HASH = `0x${'ab'.repeat(32)}` as const;

describe('multi-step trades keep the record of every sent transaction', () => {
  it('passes the first failure through untouched: nothing went out', async () => {
    const failure = new Error('Simulation failed: nope. Nothing was sent.');
    await expect(txStep([], 'Wrap 1 ETH', async () => { throw failure; })).rejects.toBe(failure);
  });

  it('lists the earlier transactions and never claims nothing was sent', async () => {
    const log = [`Wrapped 0.7 ETH (tx ${HASH}).`];
    const err = await txStep(log, 'Approve 1.2 WETH to Seaport', async () => { throw new Error('Simulation failed: reverted. Nothing was sent.'); }).catch(e => e as Error);
    expect(err).toBeInstanceOf(TradeStoppedError);
    expect(err.message).toContain('Stopped part-way. These transactions already went out:');
    expect(err.message).toContain(`- Wrapped 0.7 ETH (tx ${HASH}).`);
    expect(err.message).toContain('- Approve 1.2 WETH to Seaport: FAILED (Simulation failed: reverted. This step was not sent.)');
    expect(err.message).not.toMatch(/Nothing was sent/);
    expect(errorText(err)).toBe(err.message);
  });

  it('reports an unconfirmed transaction as sent, even when it is the first one', async () => {
    const err = await txStep([], 'Approve the OpenSea conduit', async () => { throw new UnconfirmedTxError(1, HASH); }).catch(e => e as Error);
    expect(err).toBeInstanceOf(TradeStoppedError);
    expect(err.message).toContain(`SENT, not yet confirmed: ${HASH} - do not retry`);
  });

  it('keeps the record when a later non-transaction step fails', () => {
    const log = [`Approved the OpenSea conduit on 0x1 (tx ${HASH}).`];
    const err = afterSends(log, new GuardError('This collection blocks transfers through the OpenSea conduit; the offer was not accepted.')) as Error;
    expect(err).toBeInstanceOf(TradeStoppedError);
    expect(err.message).toContain(HASH);
    expect(err.message).toContain('Then: This collection blocks transfers');
    expect(afterSends([], err)).toBe(err);
    const rejected = new RejectedOrderError('already has the log');
    expect(afterSends(log, rejected)).toBe(rejected);
  });
});
