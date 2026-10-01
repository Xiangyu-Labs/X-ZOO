import { RichText, type BlockHost, type RichTextProps } from '@shop/storefront-blocks';
import { assetUrl } from '@/lib/asset-url';

const FLAT: RichTextProps['style'] = { marginY: 'none', paddingX: 'none', radius: 'none' };
const EVERYONE: RichTextProps['visibility'] = { audience: 'all', platforms: [] };

/**
 * A picture in operator HTML is often stored site-relative (`/uploads/…`, the admin editor's
 * inserts): against the API origin it loads, as it is it loads nothing here.
 */
const HOST: BlockHost = { resolveImage: (src) => assetUrl(src) ?? src };

/**
 * Operator HTML (协议, 资讯, 商品详情) drawn natively: the DIY 富文本 block without its frame, so
 * the same allow-list and typography apply everywhere. Links inside are not tappable in a
 * mini-program; `extractLinks` lists them separately.
 */
export function RichContent({ html }: { html: string }) {
  return <RichText props={{ html, style: FLAT, visibility: EVERYONE }} host={HOST} />;
}
