'use client';

import { useEffect } from 'react';

/**
 * Ctrl/⌘+S runs `save` instead of the browser's 「网页另存为」, on a page whose
 * job is one long form (商品编辑, 系统设置, 店铺装修). Off while `enabled` is
 * false — a read-only form has nothing to save.
 */
export function useSaveShortcut(save: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, save]);
}
