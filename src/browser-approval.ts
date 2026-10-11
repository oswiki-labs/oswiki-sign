import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HumanConfirmer, HumanDecision } from './server.js';

export type Opener = (url: string) => Promise<void>;

export class BrowserOpenError extends Error {
  constructor() {
    super('could not open the browser approval page on this computer');
    this.name = 'BrowserOpenError';
  }
}

interface Approval {
  title: string;
  message: string;
  csrf: string;
  session: string | null;
  claimedAt: number;
  timer: NodeJS.Timeout;
  settle: (decision: HumanDecision) => void;
}

interface Settled {
  decision: HumanDecision;
  session: string | null;
  timer: NodeJS.Timeout;
  alarmed: boolean;
}

export interface BrowserApprovalOptions {
  timeoutMs: number;
  port?: number;
  open?: Opener;
  now?: () => number;
}

export const MIN_APPROVE_MS = 1000;
export const SETTLED_KEEP_MS = 10 * 60_000;

const ROUTE = /^\/a\/([0-9a-f]{32})(?:\/(approve|decline))?$/;
const MAX_BODY = 4096;

/** Same-origin keeps the Origin header on our own form posts; no-referrer would turn it into "null". */
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  Connection: 'close',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function browserApprovalEnabled(env: NodeJS.ProcessEnv): boolean {
  return !['0', 'false', 'off', 'no'].includes(env.OSWIKI_BROWSER_APPROVAL?.trim().toLowerCase() ?? '');
}

export function defaultOpener(url: string): Promise<void> {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    // stdout is the MCP channel, so the child must never inherit it.
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 5000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`opener exited with ${code}`));
    });
  });
}

/** One-time approval pages on 127.0.0.1 for MCP clients without elicitation; the link never goes to the AI. */
export class BrowserApproval implements HumanConfirmer {
  private readonly approvals = new Map<string, Approval>();
  private readonly settled = new Map<string, Settled>();
  private server: Server | null = null;
  private listening: Promise<number> | null = null;

  constructor(private readonly options: BrowserApprovalOptions) {}

  available(): boolean {
    return true;
  }

  where(): 'browser' {
    return 'browser';
  }

  get pending(): number {
    return this.approvals.size;
  }

  get running(): boolean {
    return this.server !== null;
  }

  async ask(message: string, title = 'Sign and send this trade', signal?: AbortSignal): Promise<HumanDecision> {
    if (signal?.aborted) return 'declined';
    const token = randomBytes(16).toString('hex');
    const cancel = () => this.settle(token, 'declined');
    const decision = new Promise<HumanDecision>((resolve) => {
      const timer = setTimeout(cancel, this.options.timeoutMs);
      timer.unref();
      this.approvals.set(token, { title, message, csrf: randomBytes(16).toString('hex'), session: null, claimedAt: 0, timer, settle: resolve });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    void decision.finally(() => signal?.removeEventListener('abort', cancel));
    try {
      const port = await this.start();
      await (this.options.open ?? defaultOpener)(`http://127.0.0.1:${port}/a/${token}`);
    } catch {
      this.settle(token, 'declined');
      await decision;
      throw new BrowserOpenError();
    }
    return decision;
  }

  close(): void {
    for (const token of [...this.approvals.keys()]) this.settle(token, 'declined');
    for (const record of this.settled.values()) clearTimeout(record.timer);
    this.settled.clear();
    this.stop();
  }

  private settle(token: string, decision: HumanDecision): void {
    const approval = this.approvals.get(token);
    if (!approval) return;
    this.approvals.delete(token);
    clearTimeout(approval.timer);
    const timer = setTimeout(() => {
      this.settled.delete(token);
      this.stopIfIdle();
    }, SETTLED_KEEP_MS);
    timer.unref();
    this.settled.set(token, { decision, session: approval.session, timer, alarmed: false });
    approval.settle(decision);
    this.stopIfIdle();
  }

  /** An approved link stays answerable for a while, so a browser that opens it late can raise the alarm. */
  private stopIfIdle(): void {
    if (this.approvals.size > 0) return;
    for (const record of this.settled.values()) if (record.decision === 'confirmed') return;
    this.stop();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private stop(): void {
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    server.close();
    server.closeIdleConnections();
  }

  private start(): Promise<number> {
    if (this.listening) return this.listening;
    let port = 0;
    const server = createServer((req, res) => {
      this.handle(req, res, port).catch(() => {
        if (!res.headersSent) res.writeHead(500, HEADERS);
        res.end();
      });
    });
    this.server = server;
    this.listening = new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve(port);
      });
    });
    this.listening.catch(() => {
      if (this.server === server) this.stop();
    });
    return this.listening;
  }

  private async handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, page('Refused', '<p>Open this page only through the link oswiki-sign opened.</p>'));
    const match = ROUTE.exec(req.url ?? '');
    if (!match) return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
    const [, token = '', action] = match;
    const approval = this.approvals.get(token);

    if (!action) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, page('Not allowed', '<p>Use the buttons on the approval page.</p>'), { Allow: 'GET' });
      if (!approval) return this.settledPage(req, res, token);
      if (req.method === 'HEAD') return send(res, 200, '');
      // The first browser to open the link owns it; anyone else opening it declines the approval.
      if (approval.session === null) {
        approval.session = randomBytes(16).toString('hex');
        approval.claimedAt = this.now();
        return send(res, 200, approvalPage(token, approval), { 'Set-Cookie': `s=${approval.session}; HttpOnly; SameSite=Strict; Path=/a/${token}` });
      }
      if (sameSecret(sessionOf(req), approval.session)) return send(res, 200, approvalPage(token, approval));
      this.settle(token, 'declined');
      return send(res, 409, page('Declined for safety', '<p>This approval link was already opened somewhere else, so oswiki-sign declined it. Nothing was signed, sent or changed. If that was not you, stop the AI and check this computer.</p>'));
    }

    if (req.method !== 'POST') return send(res, 405, page('Not allowed', '<p>Use the buttons on the approval page.</p>'), { Allow: 'POST' });
    if (req.headers.origin !== origin) return send(res, 403, page('Refused', '<p>This request did not come from the approval page.</p>'));
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return send(res, 403, page('Refused', '<p>This request did not come from the approval page.</p>'));
    const body = await readBody(req);
    if (body === null) return send(res, 413, page('Refused', '<p>Request too large.</p>'));
    if (!approval) return send(res, 410, closedPage());
    if (!sameSecret(new URLSearchParams(body).get('csrf') ?? '', approval.csrf)) return send(res, 403, page('Refused', '<p>This request did not come from the approval page.</p>'));
    if (approval.session === null || !sameSecret(sessionOf(req), approval.session)) return send(res, 403, page('Refused', '<p>This request did not come from the browser that opened the approval page.</p>'));

    const decision: HumanDecision = action === 'approve' ? 'confirmed' : 'declined';
    // The link is in the opener's argv; a program racing the browser answers within milliseconds of its GET.
    if (decision === 'confirmed' && this.now() - approval.claimedAt < MIN_APPROVE_MS) {
      return send(res, 425, page('Too fast', `<p>Too fast - click Approve again.</p><p><a href="/a/${token}">Back to the approval</a></p>`));
    }
    send(res, 200, decision === 'confirmed'
      ? page('Approved', '<p>Approved. oswiki-sign is going ahead. You can close this tab and go back to your AI client.</p>')
      : page('Declined', '<p>Declined. Nothing was signed, sent or changed. You can close this tab.</p>'));
    this.settle(token, decision);
  }

  private settledPage(req: IncomingMessage, res: ServerResponse, token: string): void {
    const record = this.settled.get(token);
    if (record?.decision !== 'confirmed' || (record.session !== null && sameSecret(sessionOf(req), record.session))) return send(res, 410, closedPage());
    if (!record.alarmed) {
      record.alarmed = true;
      console.error('oswiki-sign: WARNING: an approval was answered by another program before the browser opened it. Stop the AI and check this computer.');
    }
    return send(res, 410, page('Answered by another program', '<p class="alarm">This approval was answered by another program before your browser opened it. Stop the AI and check this computer.</p>'));
  }
}

function sessionOf(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === 's' && value) return value;
  }
  return '';
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, ...extra });
  res.end(html);
}

function closedPage(): string {
  return page('Approval closed', '<p>This approval is closed: it was already answered or it expired. Nothing more happens from this page.</p>');
}

function approvalPage(token: string, approval: Approval): string {
  const csrf = `<input type="hidden" name="csrf" value="${approval.csrf}">`;
  return page(approval.title, [
    '<p class="lead">oswiki-sign asks you to approve exactly this. Only you can answer here; the AI cannot.</p>',
    `<pre>${escapeHtml(approval.message)}</pre>`,
    '<div class="actions">',
    `<form method="post" action="/a/${token}/approve">${csrf}<button class="approve" type="submit">Approve</button></form>`,
    `<form method="post" action="/a/${token}/decline">${csrf}<button type="submit">Decline</button></form>`,
    '</div>',
  ].join('\n'));
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>oswiki-sign: ${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1b1b1b;--muted:#5f5f5a;--card:#fff;--line:#d9d9d4;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#a3a3a3;--card:#1e1e1e;--line:#333;--accent:#f97316}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}
.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:2px solid var(--accent);display:inline-block;padding-bottom:4px}
h1{font-size:22px;margin:12px 0 8px}.lead{color:var(--muted)}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Consolas,monospace}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}form{margin:0}
button{font:inherit;font-weight:600;padding:10px 22px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.approve{background:var(--accent);border-color:var(--accent);color:#fff}
.alarm{font-size:18px;font-weight:700;color:#fff;background:#b91c1c;border-radius:8px;padding:16px}
a{color:var(--accent)}
</style></head>
<body><main><div class="kicker">oswiki-sign</div><h1>${escapeHtml(title)}</h1>
${body}
</main></body></html>`;
}
