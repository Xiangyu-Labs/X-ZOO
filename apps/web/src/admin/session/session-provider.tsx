'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Button, Result, Spin } from 'antd';
import { useRouter } from 'next/navigation';
import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from 'react';

import { isSessionExpiry, loginUrl } from '../api/config';
import { adminLogout, adminMe, type AdminIdentity } from '../api/contracts';
import { errorMessage } from '../api/errors';
import { useRouteMutation, useRouteQuery } from '../api/hooks';
import { hasPermission, type PermissionInput } from './permissions';

export interface SessionValue {
  identity: AdminIdentity;
  /** Re-reads `GET /admin-api/auth/me`; call after changing your own profile. */
  refresh: () => Promise<void>;
  logout: () => void;
  loggingOut: boolean;
  can: (required: PermissionInput) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Throws outside `<SessionProvider>`; every page under `(shell)` is inside one. */
export function useSession(): SessionValue {
  const ctx = use(SessionContext);
  if (!ctx) throw new Error('useSession 必须在 <SessionProvider> 内使用');
  return ctx;
}

/** `useSession()` without throwing — for chrome that may render signed out. */
export function useOptionalSession(): SessionValue | null {
  return use(SessionContext);
}

/** `can('coupon:template:update')` / `can(['a', 'b'])` — true if any atom matches. */
export function useCan(): (required: PermissionInput) => boolean {
  return useSession().can;
}

export function loginHref(nextUrl?: string, options: { expired?: boolean } = {}): string {
  return loginUrl(nextUrl, options);
}

/**
 * Loads the signed-in admin once and holds it for the whole shell.
 *
 * A 401 is not an error here — it means "not signed in", so the provider sends
 * the browser to the login page with a `next` back-link instead of toasting.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const me = useRouteQuery(adminMe, undefined, {
    presentError: false,
    retry: false,
    staleTime: 5 * 60_000,
    call: { onUnauthorized: 'throw' },
  });

  const unauthenticated = me.isError && me.error.status === 401;
  const expired = me.isError && isSessionExpiry(me.error);

  useEffect(() => {
    if (!unauthenticated) return;
    const here =
      typeof window === 'undefined'
        ? undefined
        : `${window.location.pathname}${window.location.search}`;
    router.replace(loginHref(here, { expired }));
  }, [unauthenticated, expired, router]);

  const logoutMutation = useRouteMutation(adminLogout, {
    onSuccess() {
      queryClient.clear();
      router.replace('/admin/login');
    },
  });

  const identity = me.data as AdminIdentity | undefined;

  const refresh = useCallback(async () => {
    await me.refetch();
  }, [me]);

  const { mutate: doLogout } = logoutMutation;
  const logout = useCallback(() => doLogout({ body: {} }), [doLogout]);

  const value = useMemo<SessionValue | null>(
    () =>
      identity
        ? {
            identity,
            refresh,
            logout,
            loggingOut: logoutMutation.isPending,
            can: (required) => hasPermission(identity, required),
          }
        : null,
    [identity, refresh, logout, logoutMutation.isPending],
  );

  if (me.isPending || unauthenticated) {
    return (
      <div
        style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}
        data-testid="session-loading"
      >
        <Spin size="large" description="加载中…" />
      </div>
    );
  }

  if (me.isError || !value) {
    return (
      <Result
        status="error"
        title="无法加载登录信息"
        subTitle={errorMessage(me.error, '请稍后重试')}
        extra={
          <Button type="primary" onClick={() => me.refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  return <SessionContext value={value}>{children}</SessionContext>;
}

/** Test/Storybook helper: supplies a fixed identity without hitting the network. */
export function MockSessionProvider({
  identity,
  children,
}: {
  identity: AdminIdentity;
  children: ReactNode;
}) {
  const value = useMemo<SessionValue>(
    () => ({
      identity,
      refresh: async () => {},
      logout: () => {},
      loggingOut: false,
      can: (required) => hasPermission(identity, required),
    }),
    [identity],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}
