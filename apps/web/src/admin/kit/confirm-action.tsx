'use client';

import { Button, Popconfirm, type ButtonProps } from 'antd';
import type { ReactNode } from 'react';

export interface ConfirmActionProps extends Omit<ButtonProps, 'onClick'> {
  /** Runs on click, or once the admin confirms when `confirm` is set. */
  onAction: () => void;
  /**
   * Ask first. Pass it only for the direction that hurts — 停用, 下架, 作废 —
   * and leave it `undefined` for the harmless one (启用, 上架), so a toggle
   * asks exactly when it should. Name the thing in the title.
   */
  confirm?:
    | {
        title: ReactNode;
        description?: ReactNode | undefined;
        okText?: string | undefined;
      }
    | undefined;
  children: ReactNode;
}

/**
 * A row action that may need a confirmation, for mutations a page runs itself
 * (a shared `useRouteMutation`, a body decided at click time) where
 * `<ConfirmButton>` does not fit.
 */
export function ConfirmAction({ onAction, confirm, children, ...buttonProps }: ConfirmActionProps) {
  if (!confirm) {
    return (
      <Button {...buttonProps} onClick={onAction}>
        {children}
      </Button>
    );
  }
  return (
    <Popconfirm
      title={confirm.title}
      description={confirm.description}
      okText={confirm.okText ?? '确定'}
      cancelText="取消"
      onConfirm={onAction}
    >
      <Button {...buttonProps}>{children}</Button>
    </Popconfirm>
  );
}
