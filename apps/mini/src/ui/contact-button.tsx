import type { ReactNode } from 'react';
import { Button as TaroButton } from '@tarojs/components';
import { useAppConfig } from '@/app-config';
import { cx } from '@/lib/cx';
import { callPhone } from '@/platform';
import type { ActionBarIcon } from './action-bar';
import { Button, H5_BUTTON_ROLE, type ButtonLook } from './button';
import { toast } from './feedback';
import { Pressable } from './pressable';
import './contact-button.scss';

/**
 * The customer-service session source (C15): which page and thing the shopper asked from, so
 * the agent sees 「商品 12」 rather than a bare chat.
 */
export function sessionFromOf(route: string, id?: string): string {
  return id ? `route:${route};id:${id}` : `route:${route}`;
}

/** What 客服 does in this shop: WeChat's own chat, a phone call, or nothing. */
export function useSupport(): { kind: 'none' | 'phone' | 'mini-program'; phone: string | null } {
  const config = useAppConfig();
  const support = config?.support;
  if (!support) return { kind: 'none', phone: null };
  if (support.kind === 'phone' && !support.phone) return { kind: 'none', phone: null };
  return { kind: support.kind, phone: support.phone };
}

/** The 客服 entry for an `ActionBar`, or `null` when the shop has none. */
export function useContactIcon(sessionFrom: string): ActionBarIcon | null {
  const support = useSupport();
  if (support.kind === 'mini-program')
    return { icon: 'service', label: '客服', contact: { sessionFrom } };
  if (support.kind === 'phone' && support.phone) {
    const phone = support.phone;
    return { icon: 'service', label: '客服', onClick: () => callPhone(phone) };
  }
  return null;
}

export interface ContactButtonProps extends ButtonLook {
  sessionFrom: string;
  children?: ReactNode;
}

/**
 * 联系客服 (design.md §4.4, C15): `open-type="contact"` when the shop uses WeChat's customer
 * service, a call when it has a hotline, nothing when it has neither.
 */
export function ContactButton({ sessionFrom, children = '联系客服', ...look }: ContactButtonProps) {
  const support = useSupport();
  if (support.kind === 'mini-program') {
    return (
      <Button variant="outline" {...look} openType="contact" sessionFrom={sessionFrom}>
        {children}
      </Button>
    );
  }
  if (support.kind === 'phone' && support.phone) {
    const phone = support.phone;
    return (
      <Button
        variant="outline"
        {...look}
        label={`拨打客服电话 ${phone}`}
        onClick={() => callPhone(phone)}
      >
        {children}
      </Button>
    );
  }
  return null;
}

export interface ContactAreaProps {
  sessionFrom: string;
  /** What a screen reader announces (the face inside is usually an icon and a word). */
  label?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * Makes any face a 客服 entry (a decor block's 联系客服 cell): WeChat's `open-type="contact"`
 * button with no look of its own when the shop uses WeChat's customer service, a call when it
 * has a hotline, and a short note when it has neither, so the tap never does nothing.
 */
export function ContactArea({
  sessionFrom,
  label = '联系客服',
  className,
  children,
}: ContactAreaProps) {
  const support = useSupport();
  if (support.kind === 'mini-program') {
    return (
      <TaroButton
        className={cx('shop-contact-area', className)}
        {...H5_BUTTON_ROLE}
        openType="contact"
        sessionFrom={sessionFrom}
        ariaLabel={label}
      >
        {children}
      </TaroButton>
    );
  }
  const phone = support.kind === 'phone' ? support.phone : null;
  return (
    <Pressable
      className={className}
      label={phone ? `拨打客服电话 ${phone}` : label}
      onClick={() => (phone ? callPhone(phone) : toast.text('暂未开通在线客服'))}
    >
      {children}
    </Pressable>
  );
}
