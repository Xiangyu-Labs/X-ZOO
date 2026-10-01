'use client';

import { App } from 'antd';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

/**
 * While `dirty`, leaving the page asks first.
 *
 * Two ways out are covered. Closing or reloading the tab gets the browser's
 * own prompt (`beforeunload`). A click on an in-app link — the side menu, a
 * breadcrumb, a 「查看订单」 in a table — is caught before Next's router sees
 * it and asks 「有未保存的修改」; 仍然离开 then goes where the link pointed.
 * Before this, only the tab close was guarded, and one click on the side menu
 * dropped a half-edited product without a word.
 *
 * A page's own 返回列表 button navigates in code, which no listener sees, so
 * the hook returns `leave(href)`: the same question, then `router.push`.
 *
 * Not covered: the browser's back button — the app router gives no way to
 * cancel it.
 */
export function useLeaveGuard(dirty: boolean): (href: string) => void {
  const { modal } = App.useApp();
  const router = useRouter();
  const asking = useRef(false);

  const confirmLeave = useCallback(
    (href: string) => {
      if (asking.current) return;
      asking.current = true;
      modal.confirm({
        title: '有未保存的修改',
        content: '离开后这些修改会丢失。',
        okText: '仍然离开',
        okButtonProps: { danger: true },
        cancelText: '继续编辑',
        focusable: { autoFocusButton: 'cancel' },
        // Above the 店铺装修 editor's own overlays.
        zIndex: 1100,
        onOk: () => {
          asking.current = false;
          router.push(href);
        },
        onCancel: () => {
          asking.current = false;
        },
      });
    },
    [modal, router],
  );

  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    const onClick = (event: MouseEvent): void => {
      // A new tab, a download or another site leaves this page alone.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      // Capture phase on the document: neither the browser nor `<Link>`'s
      // own handler gets the click.
      event.preventDefault();
      event.stopPropagation();
      confirmLeave(`${url.pathname}${url.search}${url.hash}`);
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, confirmLeave]);

  return useCallback(
    (href: string) => {
      if (dirty) confirmLeave(href);
      else router.push(href);
    },
    [dirty, confirmLeave, router],
  );
}
