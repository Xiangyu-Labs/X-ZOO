import { View } from '@tarojs/components';
import type { DescriptionBlock } from '@shop/contracts/catalog/description';
import { cx } from '@/lib/cx';
import { VideoPlayer } from '@/ui/video-player';
import { RichContent } from './rich-content';
import './description-blocks.scss';

/** The blocks worth drawing: an empty rich text or a video without a file shows nothing. */
function shown(blocks: readonly DescriptionBlock[] | undefined, html: string | null) {
  const list = (blocks ?? []).filter((block) =>
    block.type === 'richText' ? block.html.trim() !== '' : block.src.trim() !== '',
  );
  // A server from before the blocks sends only the HTML.
  if (blocks === undefined && html !== null && html.trim() !== '') {
    return [{ id: 'html', type: 'richText' as const, html }];
  }
  return list;
}

/** Whether a product has any 商品详情 to show. */
export function hasDescription(
  blocks: readonly DescriptionBlock[] | undefined,
  html: string | null,
): boolean {
  return shown(blocks, html).length > 0;
}

/**
 * 商品详情 in the order the shop arranged it: rich text drawn natively, videos as their cover
 * with ▶, played on a tap (`VideoPlayer`).
 */
export function DescriptionBlocks({
  blocks,
  html,
}: {
  blocks: readonly DescriptionBlock[] | undefined;
  html: string | null;
}) {
  return (
    <View className="description-blocks">
      {shown(blocks, html).map((block, index) => (
        <View
          key={block.id}
          className={cx('description-blocks__item', index > 0 && 'description-blocks__item--after')}
        >
          {block.type === 'richText' ? (
            <RichContent html={block.html} />
          ) : (
            <VideoPlayer src={block.src} poster={block.posterUrl} label="详情视频" />
          )}
        </View>
      ))}
    </View>
  );
}
