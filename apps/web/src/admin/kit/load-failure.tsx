'use client';

import { Alert, Button } from 'antd';

import { ApiError } from '../api/errors';

export interface LoadFailureProps {
  error: unknown;
  /** Return the read's promise (`() => query.refetch()`), per AGENTS.md 17. */
  onRetry: () => unknown;
}

/**
 * The banner for something that would not load, with 重试 beside it. Never a
 * field error: nothing was submitted. Used by the form dialogs, the detail
 * drawers and the full-page editors, so a failed read looks and recovers the
 * same everywhere instead of leaving an empty card.
 */
export function LoadFailure({ error, onRetry }: LoadFailureProps) {
  const message = ApiError.is(error) ? error.message : '加载失败，请重试';
  return (
    <Alert
      type="error"
      showIcon
      message={message}
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
    />
  );
}
