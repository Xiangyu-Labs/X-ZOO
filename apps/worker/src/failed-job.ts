import { summaryOf, UNEXPLAINED } from '@shop/core/kernel';

/**
 * What 失败的后台任务 says about a job the worker gave up on, written next to
 * the raw text (`failed_jobs.error`, under 技术详情). Staff read Chinese only
 * (AGENTS.md rule 1): an exception's message stays raw, and only an error that
 * says it in Chinese (`summaryOf`) is shown as it is.
 */

/** A job from a newer deployment, or a retired one: nothing here runs it. */
export const NO_HANDLER_SUMMARY = `当前版本的后台程序没有这个任务的处理逻辑，已跳过，${UNEXPLAINED}`;

/** A job that failed every attempt BullMQ gave it. */
export function exhaustedSummary(error: unknown, attempts: number): string {
  return summaryOf(error) ?? `重试 ${attempts} 次后仍然失败，${UNEXPLAINED}`;
}
