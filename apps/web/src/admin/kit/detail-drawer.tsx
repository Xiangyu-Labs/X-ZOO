'use client';

import { Drawer, Flex, Skeleton } from 'antd';
import { useState, type ReactNode } from 'react';

import { LoadFailure } from './load-failure';

/** What the drawer needs from a `useRouteQuery` result. */
export interface DetailQuery<T> {
  data: T | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface DetailDrawerProps<T> {
  open: boolean;
  onClose: () => void;
  /** A node, or built from the record once it is there. */
  title: ReactNode | ((data: T | undefined) => ReactNode);
  /** 720 (default) or 960 — the same two widths as `DrawerForm`. */
  size?: 'medium' | 'large' | undefined;
  /** The detail read. Pass `presentError: false` to it: the drawer says what went wrong itself. */
  query: DetailQuery<T>;
  children: (data: T) => ReactNode;
  /**
   * What can be done to this record — the same actions as its table row, so
   * the operator who opened it to read can act without closing it. Right
   * aligned; return `null` when the viewer may do nothing.
   */
  footer?: ((data: T) => ReactNode) | undefined;
}

const WIDTH = { medium: 720, large: 960 } as const;

/**
 * The drawer a list row opens to show one record.
 *
 * - While it loads, a skeleton; never an empty card that looks like a record
 *   with nothing in it.
 * - When it fails, the reason and 重试 in the drawer, not only a toast that is
 *   gone before the operator looks.
 * - While it closes, the record stays on screen instead of collapsing into a
 *   skeleton for the length of the animation.
 */
export function DetailDrawer<T>({
  open,
  onClose,
  title,
  size = 'medium',
  query,
  children,
  footer,
}: DetailDrawerProps<T>) {
  // The last record shown, adjusted during render (React's "store information
  // from previous renders" pattern) so the closing drawer still has it.
  const [last, setLast] = useState<T | undefined>(undefined);
  if (query.data !== undefined && query.data !== last) setLast(query.data);
  const data = query.data ?? (open ? undefined : last);

  const actions = data !== undefined && footer ? footer(data) : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={WIDTH[size]}
      title={typeof title === 'function' ? title(data) : title}
      footer={
        actions ? (
          <Flex justify="flex-end" gap={8} wrap>
            {actions}
          </Flex>
        ) : null
      }
    >
      {data !== undefined ? (
        children(data)
      ) : query.isError ? (
        <LoadFailure error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <Skeleton active paragraph={{ rows: 8 }} />
      )}
    </Drawer>
  );
}
