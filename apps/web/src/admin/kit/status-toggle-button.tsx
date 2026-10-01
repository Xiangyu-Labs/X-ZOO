'use client';

import { Button } from 'antd';
import type { ReactNode } from 'react';

import type { RouteInput } from '../api/call-route';
import type { AnyRouteDef } from '../api/contracts';
import { useRouteMutation } from '../api/hooks';
import { ConfirmButton } from './confirm-button';

export interface StatusToggleButtonProps<R extends AnyRouteDef> {
  /** The set-status route, e.g. `couponAdminSetStatus`. */
  route: R;
  /** Whether the row is on (启用 / 已发布 / 进行中) right now. */
  on: boolean;
  /** The request that switches the row on (`true`) or off (`false`). */
  input: (next: boolean) => NoInfer<RouteInput<R>>;
  /** `[turn on, turn off]`. Default `['启用', '停用']`. */
  labels?: readonly [string, string] | undefined;
  /** Asked before switching off, e.g. `停用优惠券「新人券」？`. */
  confirmTitle: ReactNode;
  /** What switching off does to shoppers, when it is not obvious. */
  confirmDescription?: ReactNode | undefined;
  /** Routes to refetch on success — normally the list this row came from. */
  invalidate?: readonly AnyRouteDef[] | undefined;
  disabled?: boolean | undefined;
}

/**
 * The 启用/停用 link in a row's 操作 column.
 *
 * Each button owns its request, so only the row that was clicked spins (one
 * mutation shared by the page made every row's button spin together).
 * Switching off hides something from shoppers or staff, so it asks first;
 * switching back on does not. The toast says which way it went.
 */
export function StatusToggleButton<R extends AnyRouteDef>({
  route,
  on,
  input,
  labels = ['启用', '停用'],
  confirmTitle,
  confirmDescription,
  invalidate,
  disabled,
}: StatusToggleButtonProps<R>) {
  const [onLabel, offLabel] = labels;
  const turnOn = useRouteMutation(route, {
    ...(invalidate ? { invalidate } : {}),
    successMessage: `已${onLabel}`,
  });

  if (on) {
    return (
      <ConfirmButton
        route={route}
        input={() => input(false)}
        title={confirmTitle}
        description={confirmDescription}
        okText={offLabel}
        {...(invalidate ? { invalidate } : {})}
        successMessage={`已${offLabel}`}
        buttonProps={{ type: 'link', size: 'small', ...(disabled ? { disabled } : {}) }}
      >
        {offLabel}
      </ConfirmButton>
    );
  }

  return (
    <Button
      type="link"
      size="small"
      disabled={disabled ?? false}
      loading={turnOn.isPending}
      onClick={() => turnOn.mutate(input(true))}
    >
      {onLabel}
    </Button>
  );
}
