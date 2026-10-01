'use client';

import { Button, Result } from 'antd';
import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';

import type { PermissionInput } from './permissions';
import { useCan } from './session-provider';

export interface CanProps {
  /** One atom, or an array meaning "any of these". Omitted = always visible. */
  permission?: PermissionInput | undefined;
  /** Rendered instead when the admin lacks the permission. Default: nothing. */
  fallback?: ReactNode | undefined;
  children: ReactNode;
}

/**
 * Hides UI the current admin may not use.
 *
 * ```tsx
 * <Can permission="coupon:template:update">
 *   <Button onClick={edit}>编辑</Button>
 * </Can>
 * ```
 */
export function Can({ permission, fallback = null, children }: CanProps) {
  const can = useCan();
  return <>{can(permission) ? children : fallback}</>;
}

/** The shared 403 body. Used by the guard below and by `app/admin/(shell)/403`. */
export function ForbiddenResult({ subTitle }: { subTitle?: string }) {
  return (
    <Result
      status="403"
      title="403"
      subTitle={subTitle ?? '抱歉，你没有权限访问该页面。'}
      extra={
        <Link href="/admin">
          <Button type="primary">返回首页</Button>
        </Link>
      }
    />
  );
}

/**
 * Route-level guard. Wrap the page body, not the whole route file, so the shell
 * chrome (sider, breadcrumb) still renders around the 403.
 *
 * ```tsx
 * export default function Page() {
 *   return (
 *     <RequirePermission permission="coupon:template:list">
 *       <CouponListPage />
 *     </RequirePermission>
 *   );
 * }
 * ```
 */
export function RequirePermission({
  permission,
  children,
  subTitle,
}: {
  permission: PermissionInput;
  children: ReactNode;
  subTitle?: string | undefined;
}) {
  const can = useCan();
  if (!can(permission)) return <ForbiddenResult {...(subTitle ? { subTitle } : {})} />;
  return <>{children}</>;
}

/**
 * HOC form, for pages that are a single default-exported component:
 * `export default requirePermission('coupon:template:list', CouponListPage);`
 */
export function requirePermission<P extends object>(
  permission: PermissionInput,
  Page: ComponentType<P>,
): ComponentType<P> {
  function Guarded(props: P) {
    return (
      <RequirePermission permission={permission}>
        <Page {...props} />
      </RequirePermission>
    );
  }
  Guarded.displayName = `requirePermission(${Page.displayName ?? Page.name ?? 'Page'})`;
  return Guarded;
}
