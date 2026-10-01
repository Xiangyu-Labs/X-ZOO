import { StyleProvider } from '@ant-design/cssinjs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactElement, ReactNode } from 'react';

import type { AdminIdentity } from '@/admin/api/contracts';
import { MockSessionProvider } from '@/admin/session/session-provider';

export const testIdentity: AdminIdentity = {
  id: '1',
  account: 'tester',
  name: '测试管理员',
  isSuper: false,
  permissions: ['demo:widget:list', 'demo:widget:create'],
};

/**
 * Where antd's CSS-in-JS puts its `<style>` tags: a node outside the document.
 *
 * happy-dom computes a style by matching every rule of every sheet in the
 * document against the element and each of its ancestors, and a DOM change
 * drops the cache. antd injects thousands of rules, and `*ByRole` asks for the
 * computed style of every candidate (its accessible name and its visibility),
 * so with the sheets in `<head>` half of a form test's CPU went to matching
 * selectors: 拼团活动's edit test took 4.4 s, 1.0 s without them, and the
 * unit project's summed test time fell from 172 s to 109 s.
 *
 * The cost is that antd's stylesheet no longer hides anything here: an element
 * antd hides only through a class (`.ant-form-item-hidden`, a closed
 * dropdown's `-hidden`) counts as visible to `*ByRole`. No test relied on
 * that; one that needs it can render without this wrapper.
 */
const detachedStyles = document.createElement('div');

export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface AdminRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  identity?: AdminIdentity | null;
  queryClient?: QueryClient;
}

/** Renders a component inside the same providers the real admin gives it. */
export function renderAdmin(
  ui: ReactElement,
  {
    identity = testIdentity,
    queryClient = makeTestQueryClient(),
    ...options
  }: AdminRenderOptions = {},
): RenderResult & { queryClient: QueryClient } {
  function Wrapper({ children }: { children: ReactNode }) {
    const inner = identity ? (
      <MockSessionProvider identity={identity}>{children}</MockSessionProvider>
    ) : (
      children
    );
    return (
      <QueryClientProvider client={queryClient}>
        <StyleProvider container={detachedStyles}>
          <ConfigProvider locale={zhCN} theme={{ cssVar: { prefix: 'ant' } }}>
            <App component={false}>{inner}</App>
          </ConfigProvider>
        </StyleProvider>
      </QueryClientProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient };
}

/**
 * Matcher for a Chinese control label.
 *
 * antd inserts a space between the two characters of a two-CJK-character button
 * ("保存" renders as "保 存"), and an icon contributes its own `aria-label` to
 * the accessible name, so neither an exact string nor an anchored pattern
 * matches. This is a loose substring match that tolerates both.
 */
export function zhName(text: string): RegExp {
  return new RegExp(text.split('').join('\\s*'));
}
