'use client';

import { Button, Result, Skeleton } from 'antd';
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';

import { ApiError } from '../api/errors';
import { ForbiddenResult } from '../session/can';

interface BoundaryState {
  error: Error | null;
}

/**
 * Catches a render-time failure in one page without taking the shell down, so
 * the operator keeps the sider and can navigate away.
 *
 * A 403 that escaped a page's own guard is shown as the standard 403 page —
 * that is a permissions outcome, not a crash.
 */
class PageErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[admin] 页面渲染失败', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (ApiError.is(error) && error.status === 403) {
      return <ForbiddenResult />;
    }

    return (
      <Result
        status="error"
        title="页面出错了"
        // Only an API error's message is written for the operator.
        subTitle={ApiError.is(error) ? error.message : '页面加载失败，请重试'}
        extra={
          <Button type="primary" onClick={() => this.setState({ error: null })}>
            重试
          </Button>
        }
      />
    );
  }
}

/** Error boundary + suspense fallback around the shell's content area. */
export function ContentBoundary({ children }: { children: ReactNode }) {
  return (
    <PageErrorBoundary>
      <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>{children}</Suspense>
    </PageErrorBoundary>
  );
}
