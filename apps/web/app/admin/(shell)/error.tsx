'use client';

import { Button, Result } from 'antd';
import { useEffect } from 'react';

import { ApiError } from '@/admin/api/errors';

/**
 * Next's own route-segment error boundary, one level above
 * `ContentBoundary` — it also catches failures in the layout's data.
 */
export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[admin] 路由出错', error);
  }, [error]);

  return (
    <Result
      status="error"
      title="出错了"
      // An API failure's message is Chinese and meant for the operator; any
      // other error's is a developer's (「Cannot read properties of undefined」)
      // and goes to the console only.
      subTitle={ApiError.is(error) ? error.message : '页面加载失败，请重试'}
      extra={
        <Button type="primary" onClick={reset}>
          重试
        </Button>
      }
    />
  );
}
