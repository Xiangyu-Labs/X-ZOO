import type {
  WechatMediaKind,
  WechatMediaListQuery,
  WechatMediaSyncResult,
  WechatMediaUploadBody,
  WechatMedium,
} from '@shop/contracts/wechat-oa/schemas';
import { requirePermission } from '../auth/rbac';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId, toIdOrNull } from '../kernel/ids';
import { wechatOaPermissions } from './permissions';
import {
  deleteRemoteMedium,
  listRemoteMaterial,
  uploadMedium,
  type RemoteMaterial,
} from './wechat-oa.client';
import { requireOaCredentials } from './wechat-oa.credentials';
import * as repo from './wechat-oa.repo';

/**
 * The bridge between the admin media library and WeChat's material store.
 *
 * Upload takes an **attachment id**, never a file: the bytes are already ours,
 * and a second multipart endpoint would be a second place to get the MIME check
 * and the size limit wrong. An operator picks a picture they can see.
 *
 * WeChat's store is authoritative for what exists — material can be deleted
 * from 公众平台 and our row then points at a handle that produces an empty
 * bubble. `sync` reconciles in that direction only.
 */

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** What WeChat accepts for each material type, and the size it stops at. */
const RULES: Record<
  WechatMediaKind,
  { prefixes: string[]; maxBytes: number; label: string } | undefined
> = {
  image: {
    prefixes: ['image/jpeg', 'image/png', 'image/gif', 'image/bmp'],
    maxBytes: 10 * 1024 * 1024,
    label: '图片',
  },
  thumb: { prefixes: ['image/jpeg', 'image/png'], maxBytes: 64 * 1024, label: '缩略图' },
  voice: {
    prefixes: ['audio/mpeg', 'audio/amr', 'audio/mp3', 'audio/x-mpeg'],
    maxBytes: 2 * 1024 * 1024,
    label: '语音',
  },
  video: { prefixes: ['video/mp4'], maxBytes: 10 * 1024 * 1024, label: '视频' },
  // `news` is an article, composed in 公众平台 rather than uploaded as a file.
  news: undefined,
};

export async function list(ctx: Ctx, query: WechatMediaListQuery): Promise<Paged<WechatMedium>> {
  requirePermission(ctx, wechatOaPermissions['media:read']);
  const { rows, total } = await repo.listMedia(ctx.db, {
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return { items: rows.map(toMedium), total, page: query.page, pageSize: query.pageSize };
}

export async function upload(ctx: Ctx, body: WechatMediaUploadBody): Promise<WechatMedium> {
  requirePermission(ctx, wechatOaPermissions['media:write']);
  await requireOaCredentials(ctx);

  const kind = body.kind;
  const rule = kind === 'news' ? undefined : RULES[kind];
  if (rule === undefined || kind === 'news') {
    throw new DomainError('WECHAT_OA_MEDIA_UNSUPPORTED', { message: '图文素材需在公众平台编辑' });
  }

  const attachment = await repo.findAttachment(ctx.db, fromId(body.attachmentId));
  if (!attachment) throw new DomainError('NOT_FOUND', { message: '附件不存在' });
  if (!rule.prefixes.includes(attachment.mime)) {
    throw new DomainError('WECHAT_OA_MEDIA_UNSUPPORTED', {
      message: `${rule.label}素材不支持 ${attachment.mime}`,
      details: { mime: attachment.mime, allowed: rule.prefixes },
    });
  }
  if (attachment.size > rule.maxBytes) {
    throw new DomainError('WECHAT_OA_MEDIA_UNSUPPORTED', {
      message: `${rule.label}素材不能超过 ${Math.floor(rule.maxBytes / 1024)} KB`,
      details: { size: attachment.size, maxBytes: rule.maxBytes },
    });
  }

  const bytes = await readAttachment(ctx, attachment.storageKey);
  const uploaded = await uploadMedium(ctx, {
    kind,
    bytes,
    filename: attachment.name,
    contentType: attachment.mime,
    isPermanent: body.isPermanent,
  });

  const now = ctx.clock.now();
  const row = await repo.upsertMedium(ctx.db, {
    kind,
    mediaId: uploaded.mediaId,
    attachmentId: attachment.id,
    url: uploaded.url,
    isPermanent: body.isPermanent,
    // A temporary asset lives three days. The column is `not null` for those,
    // so the expiry is computed here rather than left to a cron nobody wrote.
    ...(body.isPermanent ? {} : { expiresAt: new Date(now.getTime() + 3 * 24 * 3600 * 1000) }),
  });
  return toMedium(row);
}

export async function remove(ctx: Ctx, params: { id: string }): Promise<void> {
  requirePermission(ctx, wechatOaPermissions['media:write']);
  const row = await repo.findMedium(ctx.db, fromId(params.id));
  if (!row) throw new DomainError('WECHAT_OA_MEDIA_NOT_FOUND');

  if (row.isPermanent) {
    await requireOaCredentials(ctx);
    try {
      await deleteRemoteMedium(ctx, row.mediaId);
    } catch (error) {
      // WeChat has already forgotten it (`40007 invalid media_id`): dropping our
      // row is then the *correction*, not a second failure.
      const errcode = errcodeOf(error);
      if (errcode !== 40007) throw error;
      ctx.logger.warn(
        { mediaId: row.mediaId },
        'wechat already lost this material; dropping the row',
      );
    }
  }
  await repo.deleteMedium(ctx.db, row.id);
}

/**
 * Reconciles our rows with WeChat's permanent material.
 *
 * One direction only: WeChat is the truth about what exists. A row whose handle
 * WeChat no longer knows is removed (it renders as an empty bubble), and a
 * handle WeChat has that we do not is recorded with no attachment — an operator
 * can then use it in a reply even though it was uploaded from 公众平台.
 */
export async function sync(ctx: Ctx): Promise<WechatMediaSyncResult> {
  requirePermission(ctx, wechatOaPermissions['media:write']);
  await requireOaCredentials(ctx);

  let removed = 0;
  let added = 0;
  let unchanged = 0;

  for (const kind of ['image', 'voice', 'video'] as const) {
    const remote = await readAllMaterial(ctx, kind);
    const remoteIds = new Set(remote.map((item) => item.mediaId));
    const local = await repo.listPermanentMediaIds(ctx.db, kind);
    const localIds = new Set(local.map((row) => row.mediaId));

    const stale = local.filter((row) => !remoteIds.has(row.mediaId));
    removed += await repo.deleteMediaByIds(
      ctx.db,
      stale.map((row) => row.id),
    );

    for (const item of remote) {
      if (localIds.has(item.mediaId)) {
        unchanged += 1;
        continue;
      }
      await repo.upsertMedium(ctx.db, {
        kind,
        mediaId: item.mediaId,
        url: item.url,
        isPermanent: true,
      });
      added += 1;
    }
  }

  return { removed, added, unchanged };
}

/** WeChat pages material 20 at a time; the cap keeps a runaway account from stalling the request. */
const SYNC_PAGE = 20;
const SYNC_MAX_PAGES = 50;

async function readAllMaterial(
  ctx: Ctx,
  kind: 'image' | 'voice' | 'video',
): Promise<RemoteMaterial[]> {
  const out: RemoteMaterial[] = [];
  for (let page = 0; page < SYNC_MAX_PAGES; page += 1) {
    const { items, total } = await listRemoteMaterial(ctx, {
      kind,
      offset: page * SYNC_PAGE,
      count: SYNC_PAGE,
    });
    out.push(...items);
    if (items.length < SYNC_PAGE || out.length >= total) break;
  }
  return out;
}

/**
 * Reads an attachment's bytes back through `ctx.storage`, by its storage key.
 *
 * Not by its URL: a shop on the S3 driver with a CDN in front stores an
 * absolute URL that may be signed, cached or firewalled, and fetching it would
 * make the upload depend on our own site being reachable from our own server.
 * The key is what the driver understands, on every driver.
 */
async function readAttachment(ctx: Ctx, storageKey: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await ctx.storage.get(storageKey));
  } catch (error) {
    throw new DomainError('WECHAT_OA_MEDIA_UNSUPPORTED', {
      message: '读取附件失败，文件可能已被删除',
      details: { storageKey, reason: error instanceof Error ? error.message : 'unknown' },
    });
  }
}

function errcodeOf(error: unknown): number | undefined {
  if (error instanceof DomainError) {
    const details = error.details as { errcode?: number } | undefined;
    return details?.errcode;
  }
  return undefined;
}

function toMedium(row: repo.WechatMedium): WechatMedium {
  return {
    id: toId(row.id),
    kind: row.kind,
    mediaId: row.mediaId,
    attachmentId: toIdOrNull(row.attachmentId),
    url: row.url,
    isPermanent: row.isPermanent,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
