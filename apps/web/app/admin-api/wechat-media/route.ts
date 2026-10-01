import {
  wechatOaMediaList,
  wechatOaMediaUpload,
} from '@shop/contracts/wechat-oa/wechat-oa.media.contract';
import { wechatOaMedia } from '@shop/core/wechat-oa';
import { handle } from '../../../src/server';

/**
 * `/admin-api/wechat-media` — the handles WeChat gave us for material we hold.
 *
 * `POST` takes an **attachment id**, not a file: the bytes are already in the
 * media library, and a second multipart endpoint would be a second place to get
 * the MIME check wrong.
 */
export const GET = handle(wechatOaMediaList, (ctx, { query }) => wechatOaMedia.list(ctx, query));

export const POST = handle(wechatOaMediaUpload, async (ctx, { body }) => {
  const created = await wechatOaMedia.upload(ctx, body);
  ctx.audit(`wechat-medium:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
