import { z } from 'zod';

/**
 * 商品详情 as an ordered list of blocks: 富文本 and 视频, in the order the
 * shop arranged them. The product page, and the presale and group-buy pages
 * that show the product's details, draw them one after another.
 *
 * `descriptionHtml` stays beside it: the rich-text blocks joined, for
 * mini-program versions that only know the HTML (they skip the videos).
 */

/** How many blocks one product's details hold. */
export const DESCRIPTION_BLOCKS_MAX = 30;
/** All the rich text of one product together, as before the blocks. */
export const DESCRIPTION_HTML_MAX = 500_000;

const blockId = z.string().trim().min(1).max(32);

/** A video's address: an uploaded mp4 (`/uploads/…`) or an absolute URL. */
const videoSrc = z
  .string()
  .trim()
  .min(1, { error: '请选择视频', abort: true })
  .max(512)
  .refine((value) => /^(https?:\/\/|\/)/.test(value), '视频地址无效');

export const descriptionRichTextBlock = z.object({
  id: blockId,
  type: z.literal('richText'),
  html: z.string().max(DESCRIPTION_HTML_MAX),
});

export const descriptionVideoBlock = z.object({
  id: blockId,
  type: z.literal('video'),
  src: z.string(),
  /** Shown until it plays; `null` shows a black frame with ▶. */
  posterUrl: z.string().nullable(),
});

/** One block as the server hands it out. */
export const descriptionBlock = z.discriminatedUnion('type', [
  descriptionRichTextBlock,
  descriptionVideoBlock,
]);
export type DescriptionBlock = z.infer<typeof descriptionBlock>;

/** One block as the admin sends it: a video must have its address, a cover is optional. */
export const descriptionBlockInput = z.discriminatedUnion('type', [
  descriptionRichTextBlock,
  descriptionVideoBlock.extend({ src: videoSrc, posterUrl: z.string().max(512).optional() }),
]);
export type DescriptionBlockInput = z.infer<typeof descriptionBlockInput>;

export const descriptionBlocksInput = z
  .array(descriptionBlockInput)
  .max(DESCRIPTION_BLOCKS_MAX, `商品详情最多 ${DESCRIPTION_BLOCKS_MAX} 个组件`)
  .superRefine((blocks, ctx) => {
    let length = 0;
    for (const block of blocks) if (block.type === 'richText') length += block.html.length;
    if (length > DESCRIPTION_HTML_MAX) {
      ctx.addIssue({ code: 'custom', message: '商品详情的文字和图片太多，请删减后再保存' });
    }
  });

/**
 * The blocks a stored description stands for. A description saved before the
 * blocks (or by a server rolled back to before them) has only its HTML: that
 * is one rich-text block.
 */
export function storedDescriptionBlocks(
  html: string,
  blocks: readonly DescriptionBlock[],
): DescriptionBlock[] {
  if (blocks.length > 0) return [...blocks];
  return html.trim() === '' ? [] : [{ id: 'html', type: 'richText', html }];
}

/** The rich-text blocks joined: what `descriptionHtml` carries for older readers. */
export function descriptionHtmlOf(blocks: readonly DescriptionBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'richText' && block.html.trim() !== '' ? [block.html] : []))
    .join('\n');
}
