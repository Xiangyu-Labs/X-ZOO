import { isApiError } from '@shop/api-client';
import { navigate } from '@/platform';
import { Button } from './button';
import { Empty } from './empty';

export type ErrorKind = 'network' | 'not-found' | 'unauthenticated' | 'server';

/** Which error state an error is (design.md §4.2 `ErrorBlock`). */
export function errorKindOf(error: unknown): ErrorKind {
  if (isApiError(error)) {
    if (error.status === 0) return 'network';
    if (error.status === 404) return 'not-found';
    if (error.status === 401) return 'unauthenticated';
  }
  return 'server';
}

const COPY: Record<ErrorKind, { title: string; description: string }> = {
  network: { title: '网络不太好', description: '请检查网络设置后重试' },
  'not-found': { title: '内容不存在或已下架', description: '去看看别的吧' },
  unauthenticated: { title: '登录后查看', description: '登录后即可查看这里的内容' },
  server: { title: '加载失败', description: '服务暂时不可用，请稍后重试' },
};

export interface ErrorBlockProps {
  error: unknown;
  /** 重新加载 (network, server). */
  onRetry?: (() => void) | undefined;
  /** 去登录 (a 401 the session could not renew). Pages usually show `LoginCard` instead. */
  onLogin?: (() => void) | undefined;
  compact?: boolean | undefined;
}

/**
 * A failed load, said plainly with the next step: 重新加载; 回到首页 when the thing is gone;
 * 登录 when it needs a session. A server error shows the contract's Chinese `message` (every
 * `ApiError` carries one), never a status code or a stack.
 */
export function ErrorBlock({ error, onRetry, onLogin, compact }: ErrorBlockProps) {
  const kind = errorKindOf(error);
  const copy = COPY[kind];
  const description = kind === 'server' && isApiError(error) ? error.message : copy.description;
  let action = null;
  if (kind === 'not-found') {
    action = (
      <Button variant="outline" size="sm" onClick={() => navigate({ route: 'home' })}>
        回到首页
      </Button>
    );
  } else if (kind === 'unauthenticated') {
    if (onLogin) {
      action = (
        <Button size="sm" onClick={onLogin}>
          登录
        </Button>
      );
    }
  } else if (onRetry) {
    action = (
      <Button variant="outline" size="sm" onClick={onRetry}>
        重新加载
      </Button>
    );
  }
  return (
    <Empty
      image={kind === 'network' ? 'network' : kind === 'not-found' ? 'search' : 'general'}
      title={copy.title}
      description={description}
      actions={action}
      compact={compact}
    />
  );
}
