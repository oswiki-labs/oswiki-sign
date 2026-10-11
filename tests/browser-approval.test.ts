import { request as httpRequest } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { BrowserApproval, BrowserOpenError, browserApprovalEnabled, escapeHtml, MIN_APPROVE_MS } from '../src/browser-approval.js';
import { SEAPORT_ADDRESS } from '../src/constants.js';
import { createSignServer, type HumanConfirmer } from '../src/server.js';
import vectors from './fixtures/seaport-vectors.json' with { type: 'json' };
import { COLLECTION, confirmIdOf, ETH, fulfilledLog, harness, OTHER_SELLER, type Harness } from './helpers.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(url: string, options: { method?: string; host?: string; origin?: string | null; site?: string; body?: string; cookie?: string } = {}): Promise<Reply> {
  const target = new URL(url);
  const headers: Record<string, string> = { Host: options.host ?? target.host };
  if (options.origin !== null) headers.Origin = options.origin ?? target.origin;
  if (options.site) headers['Sec-Fetch-Site'] = options.site;
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: target.port, path: target.pathname, method: options.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function csrfOf(html: string): string {
  const match = /name="csrf" value="([0-9a-f]{32})"/.exec(html);
  if (!match) throw new Error('no csrf field');
  return match[1]!;
}

function cookieOf(reply: Reply): string {
  const header = reply.headers['set-cookie'];
  const value = (Array.isArray(header) ? header[0] : header) ?? '';
  return value.split(';')[0]!;
}

async function view(url: string): Promise<{ page: Reply; csrf: string; cookie: string }> {
  const page = await send(url);
  return { page, csrf: csrfOf(page.body), cookie: cookieOf(page) };
}

async function answer(url: string, action: 'approve' | 'decline'): Promise<Reply> {
  const { csrf, cookie } = await view(url);
  return send(`${url}/${action}`, { method: 'POST', body: `csrf=${csrf}`, cookie });
}

/** Every reading moves the clock past the minimum time between opening the page and approving. */
function patient(): () => number {
  let now = 0;
  return () => (now += MIN_APPROVE_MS);
}

function opened() {
  const urls: string[] = [];
  let notify: (url: string) => void = () => undefined;
  const next = new Promise<string>((resolve) => {
    notify = resolve;
  });
  return {
    urls,
    next,
    open: async (url: string) => {
      urls.push(url);
      notify(url);
    },
  };
}

describe('browser approval page', () => {
  it('opens a one-time 127.0.0.1 link and approves once, through a POST with the page CSRF value', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('APPROVE PURCHASE\nTotal 1 ETH', 'Buy for the total shown');
    const url = await opener.next;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[0-9a-f]{32}$/);

    const { page, csrf, cookie } = await view(url);
    expect(page.status).toBe(200);
    expect(page.headers['set-cookie']?.[0]).toMatch(/^s=[0-9a-f]{32}; HttpOnly; SameSite=Strict; Path=\/a\/[0-9a-f]{32}$/);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('Buy for the total shown');
    expect(page.body).toContain('Total 1 ETH');
    expect(page.body).not.toMatch(/<script|<link|<img|https?:\/\/(?!127)/i);

    expect((await send(`${url}/approve`, { method: 'POST', body: `csrf=${csrf}`, cookie })).status).toBe(200);
    await expect(decision).resolves.toBe('confirmed');
    expect(approval.pending).toBe(0);
    const reload = await send(url, { cookie });
    expect(reload.status).toBe(410);
    expect(reload.body).toMatch(/already answered or it expired/);
    expect(approval.running).toBe(true);
    approval.close();
    expect(approval.running).toBe(false);
    await expect(send(url)).rejects.toThrow();
  });

  it('a browser opening a link another program already approved shows the alarm and logs it once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const opener = opened();
      const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
      const decision = approval.ask('raced');
      const url = await opener.next;
      const intruder = await view(url);
      expect((await send(`${url}/approve`, { method: 'POST', body: `csrf=${intruder.csrf}`, cookie: intruder.cookie })).status).toBe(200);
      await expect(decision).resolves.toBe('confirmed');

      const human = await send(url);
      expect(human.status).toBe(410);
      expect(human.body).toContain('This approval was answered by another program before your browser opened it. Stop the AI and check this computer.');
      expect((await send(url, { cookie: 's=00000000000000000000000000000000' })).body).toMatch(/answered by another program/);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toMatch(/answered by another program/);
      expect((await send(url, { cookie: intruder.cookie })).body).toMatch(/already answered or it expired/);
      approval.close();
    } finally {
      errors.mockRestore();
    }
  });

  it('a later look at a declined or expired link shows the normal closed page', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const opener = opened();
      const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
      const keepAlive = approval.ask('still open');
      await opener.next;
      const declined = approval.ask('declined');
      await new Promise(resolve => setTimeout(resolve, 0));
      const url = opener.urls[1]!;
      expect((await answer(url, 'decline')).status).toBe(200);
      await expect(declined).resolves.toBe('declined');
      const later = await send(url);
      expect(later.status).toBe(410);
      expect(later.body).toMatch(/already answered or it expired/);
      expect(errors).not.toHaveBeenCalled();
      approval.close();
      await expect(keepAlive).resolves.toBe('declined');
    } finally {
      errors.mockRestore();
    }
  });

  it('refuses an approve that comes less than a second after the page was opened, without deciding', async () => {
    const opener = opened();
    let now = 5_000;
    const approval = new BrowserApproval({ now: () => now, timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('fast');
    const url = await opener.next;
    const { csrf, cookie } = await view(url);
    const post = () => send(`${url}/approve`, { method: 'POST', body: `csrf=${csrf}`, cookie });
    const fast = await post();
    expect(fast.status).toBe(425);
    expect(fast.body).toContain('Too fast - click Approve again');
    now += MIN_APPROVE_MS - 1;
    expect((await post()).status).toBe(425);
    expect(approval.pending).toBe(1);
    now += 1;
    expect((await post()).status).toBe(200);
    await expect(decision).resolves.toBe('confirmed');
    approval.close();
  });

  it('decline is never too fast', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: () => 0, timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('decline fast');
    expect((await answer(await opener.next, 'decline')).status).toBe(200);
    await expect(decision).resolves.toBe('declined');
  });

  it('a cancelled call declines its pending approval and a late Approve does nothing', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const controller = new AbortController();
    const decision = approval.ask('cancel me', undefined, controller.signal);
    const url = await opener.next;
    const { csrf, cookie } = await view(url);
    controller.abort();
    await expect(decision).resolves.toBe('declined');
    expect(approval.pending).toBe(0);
    expect(approval.running).toBe(false);
    await expect(send(`${url}/approve`, { method: 'POST', body: `csrf=${csrf}`, cookie })).rejects.toThrow();

    const urls = opener.urls.length;
    await expect(approval.ask('already cancelled', undefined, controller.signal)).resolves.toBe('declined');
    expect(opener.urls).toHaveLength(urls);
  });

  it('a used token is dead while other approvals keep the server up', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const first = approval.ask('first');
    const url = await opener.next;
    const first_ = await view(url);
    const second = approval.ask('second');
    await new Promise(resolve => setTimeout(resolve, 0));
    const secondUrl = opener.urls[1]!;
    expect(secondUrl).not.toBe(url);

    expect((await send(`${url}/approve`, { method: 'POST', body: `csrf=${first_.csrf}`, cookie: first_.cookie })).status).toBe(200);
    await expect(first).resolves.toBe('confirmed');
    expect((await send(`${url}/approve`, { method: 'POST', body: `csrf=${first_.csrf}`, cookie: first_.cookie })).status).toBe(410);
    const again = await send(url, { cookie: first_.cookie });
    expect(again.status).toBe(410);
    expect(again.body).toMatch(/already answered or it expired/);
    expect(approval.running).toBe(true);

    expect((await answer(secondUrl, 'decline')).status).toBe(200);
    await expect(second).resolves.toBe('declined');
    expect(approval.running).toBe(true);
    approval.close();
    expect(approval.running).toBe(false);
  });

  it('declines on timeout and closes the server', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 30, open: opener.open });
    const decision = approval.ask('slow');
    const url = await opener.next;
    await expect(decision).resolves.toBe('declined');
    expect(approval.pending).toBe(0);
    expect(approval.running).toBe(false);
    await expect(send(url)).rejects.toThrow();
  });

  it('rejects a wrong Host header (DNS rebinding) without deciding', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('host check');
    const url = await opener.next;
    const port = new URL(url).port;
    for (const host of [`localhost:${port}`, `evil.example:${port}`, '127.0.0.1']) {
      expect((await send(url, { host })).status, host).toBe(421);
      expect((await send(`${url}/approve`, { method: 'POST', host, body: 'csrf=x' })).status, host).toBe(421);
    }
    expect(approval.pending).toBe(1);
    approval.close();
    await expect(decision).resolves.toBe('declined');
  });

  it('GET cannot approve', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('get check');
    const url = await opener.next;
    expect((await send(`${url}/approve`)).status).toBe(405);
    const { csrf, cookie } = await view(url);
    expect((await send(`${url}/approve`, { method: 'PUT', body: `csrf=${csrf}`, cookie })).status).toBe(405);
    expect((await send(url, { method: 'POST', body: `csrf=${csrf}`, cookie })).status).toBe(405);
    expect(approval.pending).toBe(1);
    approval.close();
    await expect(decision).resolves.toBe('declined');
  });

  it('rejects a CSRF mismatch, a foreign or missing Origin and cross-site fetches', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('csrf check');
    const url = await opener.next;
    const { csrf, cookie } = await view(url);
    const attempts = [
      { body: 'csrf=00000000000000000000000000000000' },
      { body: '' },
      { body: `csrf=${csrf}`, origin: 'https://evil.example' },
      { body: `csrf=${csrf}`, origin: 'null' },
      { body: `csrf=${csrf}`, origin: null },
      { body: `csrf=${csrf}`, site: 'cross-site' },
      { body: `csrf=${csrf}`, cookie: '' },
      { body: `csrf=${csrf}`, cookie: 's=00000000000000000000000000000000' },
    ];
    for (const attempt of attempts) {
      expect((await send(`${url}/approve`, { method: 'POST', cookie, ...attempt })).status, JSON.stringify(attempt)).toBe(403);
    }
    expect(approval.pending).toBe(1);
    expect((await send(`${url}/approve`, { method: 'POST', site: 'same-origin', body: `csrf=${csrf}`, cookie })).status).toBe(200);
    await expect(decision).resolves.toBe('confirmed');
  });

  it('a second viewer of the link declines the approval for safety, the owner can reload', async () => {
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('stolen link');
    const url = await opener.next;
    const owner = await view(url);
    expect((await send(url, { cookie: owner.cookie })).status).toBe(200);
    expect(approval.pending).toBe(1);
    const intruder = await send(url);
    expect(intruder.status).toBe(409);
    expect(intruder.body).toMatch(/already opened somewhere else/);
    await expect(decision).resolves.toBe('declined');
    expect((await send(`${url}/approve`, { method: 'POST', body: `csrf=${owner.csrf}`, cookie: owner.cookie }).catch(() => ({ status: 0 }))).status).not.toBe(200);
  });

  it('escapes the card text', async () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
    const opener = opened();
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: opener.open });
    const decision = approval.ask('Name: <script>alert(1)</script></pre><form action="//evil">', '<img src=x>');
    const page = (await send(await opener.next)).body;
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('<img');
    expect(page).not.toContain('action="//evil"');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;/pre&gt;');
    approval.close();
    await expect(decision).resolves.toBe('declined');
  });

  it('declines with a clear error when the browser cannot be opened', async () => {
    const approval = new BrowserApproval({ now: patient(), timeoutMs: 60_000, open: async () => { throw new Error('no display'); } });
    await expect(approval.ask('x')).rejects.toBeInstanceOf(BrowserOpenError);
    expect(approval.pending).toBe(0);
    expect(approval.running).toBe(false);
  });

  it('OSWIKI_BROWSER_APPROVAL=0 switches it off', () => {
    expect(browserApprovalEnabled({})).toBe(true);
    expect(browserApprovalEnabled({ OSWIKI_BROWSER_APPROVAL: '1' })).toBe(true);
    expect(browserApprovalEnabled({ OSWIKI_BROWSER_APPROVAL: '0' })).toBe(false);
  });
});

const vectorAskId = `oswiki-${vectors.orders.erc721.orderHash}`;

function setupBuy(h: Harness) {
  h.api.routes.set(`POST /v1/listings/${vectorAskId}/buy-data`, () => ({
    askId: vectorAskId,
    to: SEAPORT_ADDRESS,
    value: ETH.toString(),
    orderData: { parameters: vectors.orders.erc721.parameters, signature: vectors.orders.erc721.signature, numerator: 1, denominator: 1, extraData: '0x' },
  }));
  h.api.routes.set(`GET /v1/listings/${vectorAskId}`, () => ({ contract: { address: COLLECTION }, tokenId: '1', maker: OTHER_SELLER, status: 'active' }));
}

function recorder(decision: 'confirmed' | 'declined'): HumanConfirmer & { asked: string[] } {
  const asked: string[] = [];
  return { asked, available: () => true, ask: async (message) => { asked.push(message); return decision; }, where: () => 'browser' };
}

async function connect(h: Harness, options: Parameters<typeof createSignServer>[1], elicitation: boolean) {
  const server = createSignServer(h.handler, options);
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
  if (elicitation) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm: true } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  return { client, call };
}

describe('browser approval wiring', () => {
  const hash = vectors.orders.erc721.orderHash as Hex;

  it('uses the browser page when the client has no elicitation', async () => {
    const h = harness({ logsFor: () => [fulfilledLog(hash, OTHER_SELLER)] });
    setupBuy(h);
    const browser = recorder('confirmed');
    const { client, call } = await connect(h, { env: {}, browser }, false);
    const preview = await call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(preview.text).toMatch(/opens as a page in the user's browser/);
    expect(preview.text).not.toMatch(/will be refused/);
    const result = await call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    expect(browser.asked).toHaveLength(1);
    expect(browser.asked[0]).toMatch(/Total +1 ETH/);
    expect(h.chain.sent).toHaveLength(1);
    await client.close();
  });

  it('prefers elicitation when the client has it', async () => {
    const h = harness({ logsFor: () => [fulfilledLog(hash, OTHER_SELLER)] });
    setupBuy(h);
    const browser = recorder('declined');
    const { client, call } = await connect(h, { env: {}, browser }, true);
    const preview = await call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(preview.text).not.toMatch(/browser/);
    expect((await call('execute', { confirmId: confirmIdOf(preview.text) })).isError).toBe(false);
    expect(browser.asked).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(1);
    await client.close();
  });

  it('OSWIKI_BROWSER_APPROVAL=0 keeps the old refusals', async () => {
    const h = harness();
    setupBuy(h);
    const browser = recorder('confirmed');
    const { client, call } = await connect(h, { env: { OSWIKI_BROWSER_APPROVAL: '0' }, browser }, false);
    const preview = await call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    expect(preview.text).toMatch(/will be refused/);
    const result = await call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/OSWIKI_BROWSER_APPROVAL=0/);
    expect((await call('preview_transfer', { chainId: 1, to: OTHER_SELLER, nativeAmount: '0.1' })).text).toMatch(/^Refused: sending/);
    expect((await call('update_limits', { maxTradesPerDay: 3 })).text).toMatch(/^Refused: changing settings/);
    expect(browser.asked).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
    await client.close();
  });

  it('setting changes go through the browser page too', async () => {
    const h = harness();
    const browser = recorder('confirmed');
    const { client, call } = await connect(h, { env: {}, browser }, false);
    const result = await call('update_limits', { maxTradesPerDay: 3 });
    expect(result.isError).toBe(false);
    expect(browser.asked[0]).toMatch(/^APPROVE SETTING CHANGES/);
    expect(h.ctx.config.maxTradesPerDay).toBe(3);
    await client.close();
  });

  it('end to end with the real page: the link and token never reach the tool output', async () => {
    const h = harness({ logsFor: () => [fulfilledLog(hash, OTHER_SELLER)] });
    setupBuy(h);
    const urls: string[] = [];
    const browser = new BrowserApproval({
      now: patient(),
      timeoutMs: 60_000,
      open: async (url) => {
        urls.push(url);
        setTimeout(() => void answer(url, 'approve'), 0);
      },
    });
    const { client, call } = await connect(h, { env: {}, browser }, false);
    const preview = await call('preview_buy', { chainId: 1, askIds: [vectorAskId] });
    const result = await call('execute', { confirmId: confirmIdOf(preview.text) });
    expect(result.isError).toBe(false);
    expect(urls).toHaveLength(1);
    const token = urls[0]!.split('/').at(-1)!;
    const port = new URL(urls[0]!).port;
    for (const text of [preview.text, result.text]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(`127.0.0.1:${port}`);
    }
    expect(h.chain.sent).toHaveLength(1);
    expect(browser.running).toBe(true);
    browser.close();
    await client.close();
  });
});
