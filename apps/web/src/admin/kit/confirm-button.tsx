'use client';

import { Button, Popconfirm, type ButtonProps } from 'antd';
import type { ReactNode } from 'react';

import type { RouteInput } from '../api/call-route';
import type { AnyRouteDef, ResponseOf } from '../api/contracts';
import { useRouteMutation } from '../api/hooks';
import { Can } from '../session/can';
import type { PermissionInput } from '../session/permissions';

export interface ConfirmButtonProps<R extends AnyRouteDef> {
  /** The mutation route, e.g. `couponDelete`. */
  route: R;
  /** Request input. A function is evaluated at click time. */
  input?: (RouteInput<R> | (() => RouteInput<R>)) | undefined;
  /** Popconfirm heading. Say what will happen, in Chinese. */
  title: ReactNode;
  description?: ReactNode | undefined;
  /** Button content. */
  children: ReactNode;
  /** Routes to invalidate on success — normally the list this row came from. */
  invalidate?: readonly AnyRouteDef[] | undefined;
  successMessage?: string | undefined;
  onSuccess?: ((data: ResponseOf<R>) => void) | undefined;
  /** Hidden entirely when the admin lacks this permission. */
  permission?: PermissionInput | undefined;
  okText?: string | undefined;
  cancelText?: string | undefined;
  buttonProps?: Omit<ButtonProps, 'onClick' | 'loading'> | undefined;
}

/**
 * A destructive/irreversible action in one component: popconfirm, mutation,
 * loading state, invalidation, success toast.
 *
 * ```tsx
 * <ConfirmButton
 *   route={couponDelete}
 *   input={{ params: { id: row.id } }}
 *   title="确认删除该优惠券？"
 *   invalidate={[couponList]}
 *   successMessage="已删除"
 *   permission="coupon:template:delete"
 *   buttonProps={{ danger: true, type: 'link', size: 'small' }}
 * >
 *   删除
 * </ConfirmButton>
 * ```
 */
export function ConfirmButton<R extends AnyRouteDef>({
  route,
  input,
  title,
  description,
  children,
  invalidate,
  successMessage,
  onSuccess,
  permission,
  okText = '确定',
  cancelText = '取消',
  buttonProps,
}: ConfirmButtonProps<R>) {
  const mutation = useRouteMutation(route, {
    ...(invalidate ? { invalidate } : {}),
    ...(successMessage ? { successMessage } : {}),
    ...(onSuccess ? { onSuccess: (data) => onSuccess(data) } : {}),
  });

  const button = (
    <Popconfirm
      title={title}
      description={description}
      okText={okText}
      cancelText={cancelText}
      okButtonProps={{ loading: mutation.isPending }}
      onConfirm={() => mutation.mutate(typeof input === 'function' ? input() : (input ?? {}))}
    >
      <Button {...buttonProps} loading={mutation.isPending}>
        {children}
      </Button>
    </Popconfirm>
  );

  return permission ? <Can permission={permission}>{button}</Can> : button;
}
