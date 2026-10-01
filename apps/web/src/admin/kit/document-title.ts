import { useEffect } from 'react';

import { SITE_TITLE } from '../site-title';

/**
 * Names the browser tab after the record on screen — 「订单 2026…」 rather than
 * the route's fixed 「订单详情」 — so an operator with five orders open can tell
 * the tabs apart. Next's metadata sets the title again on the next navigation.
 */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title) document.title = `${title} · ${SITE_TITLE}`;
  }, [title]);
}
