import { DomainError } from './errors';

/**
 * What staff read about a failure, next to what the code recorded.
 *
 * A stored `last_error` is the raw text — a gateway's errmsg, a channel id, a
 * thrown error's message — and stays for whoever debugs it, under 技术详情.
 * Staff read only Chinese (AGENTS.md rule 1), so the place that fails also
 * says, in Chinese, what went wrong: that line is the summary, and it is
 * written when the error is, by the code that knows what the error means.
 */

/** Said when nothing more specific is known; the raw text is in 技术详情 and the server log. */
export const UNEXPLAINED = '请联系技术人员查看服务器日志';

/**
 * An error that carries its own staff-facing line. The message is the raw
 * text for the log and 技术详情; `summary` is Chinese, safe to show staff.
 */
export class SummarizedError extends Error {
  readonly summary: string;

  constructor(message: string, summary: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'SummarizedError';
    this.summary = summary;
  }
}

/**
 * The Chinese line for a caught error, or `null` when the error does not say.
 * A `DomainError`'s message comes from the contracts' error registry, which is
 * Chinese and written to be shown — except `INTERNAL`, whose message a caller
 * may fill with a WeChat errmsg or a request path.
 */
export function summaryOf(error: unknown): string | null {
  if (error instanceof SummarizedError) return error.summary;
  if (error instanceof DomainError && error.code !== 'INTERNAL') return error.message;
  return null;
}
