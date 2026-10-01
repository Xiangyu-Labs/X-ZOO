import { z } from 'zod';

import { ui } from '../meta';

/**
 * The heading every marketing list shares: a title (empty hides the row) and a
 * 「更多」 link to the full list's page (领券中心, 拼团列表, 预售列表, 资讯列表).
 */
export function listHeading(defaultTitle: string) {
  return {
    title: z
      .string()
      .max(10)
      .default(defaultTitle)
      .meta(ui({ label: '标题（留空不显示）', group: '内容' })),
    showMore: z
      .boolean()
      .default(true)
      .meta(ui({ label: '显示「更多」', group: '内容' })),
  };
}
