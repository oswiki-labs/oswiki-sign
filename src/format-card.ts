import { NATIVE_SYMBOL } from './constants.js';
import { trimAmount } from './format.js';

export const CARD_WIDTH = 44;
export const CARD_RULE = '─'.repeat(CARD_WIDTH);
export const WARN = '⚠';

const RULE_MARK = '\u0000rule';

export function chainLabel(chainId: number): string {
  return chainId === 1 ? 'Ethereum' : chainId === 33139 ? 'ApeChain' : `chain ${chainId}`;
}

/** 0x1234…abcd for addresses, order hashes and "oswiki-0x…" ids. */
export function shortHex(value: string): string {
  const match = /^(oswiki-)?(0x[0-9a-fA-F]+)$/.exec(value);
  if (!match) return value.slice(0, 20);
  const hex = match[2]!.toLowerCase();
  return hex.length <= 12 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export function percentLabel(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0%';
  const hundredths = (part * 10000n + whole / 2n) / whole;
  const whole100 = hundredths / 100n;
  const rest = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return rest ? `${whole100}.${rest}%` : `${whole100}%`;
}

export function bpsLabel(bps: number): string {
  return percentLabel(BigInt(bps), 10000n);
}

export function inDays(seconds: number, nowMs: number): string {
  const days = Math.round((seconds / 86400) * 10) / 10;
  const until = new Date(nowMs + seconds * 1000).toISOString().slice(0, 10);
  return `in ${days} day${days === 1 ? '' : 's'} (${until})`;
}

export function feeValue(fee: { nowWei: bigint | null; maxWei: bigint }, chainId: number): string {
  const symbol = NATIVE_SYMBOL[chainId] ?? 'NATIVE';
  if (fee.maxWei === 0n && fee.nowWei === 0n) return 'none';
  if (fee.nowWei === null) return `max ${trimAmount(fee.maxWei)} ${symbol}`;
  return `~${trimAmount(fee.nowWei)} ${symbol} (max ${trimAmount(fee.maxWei)})`;
}

/** The sentences of a network-fee text that the user must see (gas over the cap, estimate missing). */
export function feeWarnings(fee: { nowWei: bigint | null; text: string }): string[] {
  const warnings: string[] = [];
  const over = /Gas is above [^.]*\./.exec(fee.text);
  if (over) warnings.push(over[0]);
  if (fee.nowWei === null && /estimate unavailable/.test(fee.text)) warnings.push('The network fee could not be estimated right now; it stays under the max shown.');
  return warnings;
}

const UNIT_RE = /^(ETH|APE|WETH|WAPE)\b/;

/** Joins chunks with `separator`, starting a new line before a chunk that would pass `width`. */
export function wrapChunks(chunks: string[], width: number, separator = ' '): string[] {
  const lines: string[] = [];
  let line = '';
  for (const chunk of chunks) {
    if (line === '') line = chunk;
    else if (line.length + separator.length + chunk.length <= width) line += `${separator}${chunk}`;
    else {
      lines.push(separator === ' ' ? line : `${line}${separator.trimEnd()}`);
      line = chunk;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/** Word wrap that never splits an amount from its unit ("0.5 ETH"). */
export function wrapText(text: string, width: number): string[] {
  const words: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const previous = words[words.length - 1];
    if (previous !== undefined && /[0-9]$/.test(previous) && UNIT_RE.test(word)) words[words.length - 1] = `${previous} ${word}`;
    else words.push(word);
  }
  return wrapChunks(words, width);
}

/**
 * A plain-text approval card: title, rule-separated sections, one "Details:" line.
 * Clients show it as plain text, so it only relies on a monospace-friendly layout.
 */
export class Card {
  private readonly lines: string[] = [];
  private detail: string[] = [];

  constructor(action: string, chainId: number, options: { irreversible?: boolean } = {}) {
    this.lines.push(`APPROVE ${action.toUpperCase()} · ${chainLabel(chainId)}${options.irreversible ? ' · cannot be undone' : ''}`, RULE_MARK);
  }

  /** Label left, value right-aligned; a long label wraps and keeps the value on its first line. */
  row(label: string, value = '', indent = 0): this {
    const pad = ' '.repeat(indent);
    if (value === '') return this.text(label, indent, 2);
    const room = CARD_WIDTH - indent - value.length - 2;
    if (room < 12) {
      this.text(label, indent, 2);
      this.lines.push(value.length + indent + 2 >= CARD_WIDTH ? `${pad}  ${value}` : value.padStart(CARD_WIDTH));
      return this;
    }
    const [first, ...rest] = wrapText(label, room);
    this.lines.push(`${pad}${first!}${' '.repeat(Math.max(2, CARD_WIDTH - indent - first!.length - value.length))}${value}`);
    if (rest.length > 0) for (const line of wrapText(rest.join(' '), CARD_WIDTH - indent - 2)) this.lines.push(`${pad}  ${line}`);
    return this;
  }

  /** `hang` indents the wrapped continuation lines further, e.g. under a "- " bullet. */
  text(text: string, indent = 0, hang = 0): this {
    const [first, ...rest] = wrapText(text, CARD_WIDTH - indent - hang);
    this.lines.push(`${' '.repeat(indent)}${first!}`);
    for (const line of rest) this.lines.push(`${' '.repeat(indent + hang)}${line}`);
    return this;
  }

  warn(text: string, indent = 0): this {
    this.lines.push(...warnLines(text, indent));
    return this;
  }

  rule(): this {
    this.lines.push(RULE_MARK);
    return this;
  }

  details(parts: Array<string | null | undefined | false>): this {
    this.detail = parts.filter((part): part is string => typeof part === 'string' && part !== '');
    return this;
  }

  render(): string {
    const out: string[] = [];
    for (const line of [...this.lines, RULE_MARK]) {
      if (line === RULE_MARK) {
        if (out.length > 0 && out[out.length - 1] !== CARD_RULE) out.push(CARD_RULE);
      } else {
        out.push(line);
      }
    }
    if (this.detail.length > 0) out.push(...wrapChunks([`Details: ${this.detail[0]!}`, ...this.detail.slice(1)], CARD_WIDTH, ' · '));
    else if (out[out.length - 1] === CARD_RULE) out.pop();
    return out.join('\n');
  }
}

export function warnLines(text: string, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  return wrapText(text, CARD_WIDTH - indent - 2).map((line, i) => `${pad}${i === 0 ? `${WARN} ` : '  '}${line}`);
}

/** Adds a warning to a rendered card, above its closing rule and "Details:" line. */
export function addCardWarning(card: string, warning: string): string {
  return insertCardLines(card, warnLines(warning));
}

export function addCardText(card: string, text: string): string {
  return insertCardLines(card, wrapText(text, CARD_WIDTH));
}

function insertCardLines(card: string, added: string[]): string {
  const lines = card.split('\n');
  const details = lines.findIndex(line => line.startsWith('Details: '));
  const at = details > 0 && lines[details - 1] === CARD_RULE ? details - 1 : lines.length;
  lines.splice(at, 0, ...added);
  return lines.join('\n');
}

/** A preview: `text` is the card the user approves (the dialog shows exactly this); `note` is for the AI only. */
export interface CardPreview<P> {
  text: string;
  plan: P;
  note?: string[];
}
