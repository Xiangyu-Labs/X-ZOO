'use client';

import { useEffect } from 'react';

/**
 * The last boundary: a failure in the root layout itself. It replaces the
 * whole document, so it brings its own `<html>` and says what happened in
 * Chinese — never the error's own message, which is for the console.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[web] 页面出错', error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          minHeight: '100vh',
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
          color: '#333',
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>页面出错了</h1>
        <p style={{ margin: 0, color: '#666' }}>请稍后重试；如果一直这样，请联系技术人员。</p>
        <button type="button" onClick={reset} style={{ padding: '6px 16px', cursor: 'pointer' }}>
          重试
        </button>
      </body>
    </html>
  );
}
