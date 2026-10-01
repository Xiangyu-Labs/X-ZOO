'use client';

import { App } from 'antd';

/** What a toast should say about a write, and how loudly. */
export interface Outcome {
  level: 'success' | 'info' | 'warning';
  text: string;
}

/**
 * Shows an `Outcome` as the toast. For a button whose route answers 200 in
 * more than one way — 重试 that re-queued, 重试 that found the row already
 * done, 退款 that WeChat refused — so the toast says which, instead of one
 * fixed `successMessage` (AGENTS.md rule 12: `deleted: 0` is not 已删除).
 */
export function useOutcomeToast(): (outcome: Outcome) => void {
  const { message } = App.useApp();
  return (outcome) => {
    void message[outcome.level](outcome.text);
  };
}

/**
 * The outcome of a 重试 that only re-queues (待处理任务, 通知发送记录): the
 * server's own sentence, a success only when it did re-queue. A row that is
 * somehow still parked says why it failed, in Chinese.
 */
export function queuedRetryOutcome(result: {
  succeeded: boolean;
  message: string | null;
  status: string;
  lastErrorSummary: string | null;
}): Outcome {
  if (result.succeeded) return { level: 'success', text: result.message ?? '已重新排队' };
  const why =
    result.status === 'unknown' && result.lastErrorSummary ? `：${result.lastErrorSummary}` : '';
  return { level: 'warning', text: `${result.message ?? '没有重新排队'}${why}` };
}
