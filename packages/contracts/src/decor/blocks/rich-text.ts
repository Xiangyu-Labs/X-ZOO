import { z } from 'zod';

import { blockProps } from '../base';
import { ui } from '../meta';
import { defineBlock } from '../registry';
import { RICH_TEXT_LIMITS, sanitizeRichText } from '../rich-text';

/**
 * 富文本: operator-written HTML, reduced to the allow-list in `../rich-text.ts`
 * (DECOR-017). The schema *overwrites* the value with its sanitised form, so
 * every parse cleans it: `checkDocument` stores the clean string on save, and
 * the page resolver, which parses every block it serves, cleans it again.
 */
export const richTextHtml = z
  .string()
  .max(RICH_TEXT_LIMITS.htmlLength, '内容过长')
  .overwrite(sanitizeRichText);

export const richTextProps = blockProps({
  html: richTextHtml
    .default('<p>在这里输入文字</p>')
    .meta(ui({ label: '内容', field: 'richText', group: '内容' })),
});
export type RichTextProps = z.infer<typeof richTextProps>;

export const richTextBlock = defineBlock({
  type: 'richText',
  v: 1,
  props: richTextProps,
  meta: { label: '富文本', pages: ['home', 'custom', 'user_center'] },
});
