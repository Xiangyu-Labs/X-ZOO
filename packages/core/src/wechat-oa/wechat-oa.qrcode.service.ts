import type {
  WechatQrcode,
  WechatQrcodeCategory,
  WechatQrcodeCategoryForm,
  WechatQrcodeForm,
  WechatQrcodeListQuery,
  WechatQrcodeScan,
  WechatQrcodeStatQuery,
  WechatQrcodeStatistic,
  WechatQrcodeStatusBody,
  WechatReplyPayload,
} from '@shop/contracts/wechat-oa/schemas';
import { randomBytes } from 'node:crypto';
import { requirePermission } from '../auth/rbac';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId, toIdOrNull } from '../kernel/ids';
import { wechatOaPermissions } from './permissions';
import { createQrcode as createRemoteQrcode, qrcodeImageUrl } from './wechat-oa.client';
import { requireOaCredentials } from './wechat-oa.credentials';
import { validateReplyPayload } from './wechat-oa.reply.service';
import * as repo from './wechat-oa.repo';

/**
 * Channel QR codes: a poster, a scene string, and the scans attributed to it.
 *
 * The scene string is the whole mechanism. WeChat echoes it back on every scan
 * and on the follow that a scan produces, and it is the only thing that ties a
 * new customer to the poster that brought them — which is why it is unique,
 * why it is never reused, and why `WECHAT_OA_QRCODE_SCENE_TAKEN` is a refusal
 * rather than a silent suffix.
 */

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/**
 * Every category, paged.
 *
 * The page is applied in JavaScript rather than in SQL because the list is
 * bounded by what an operator can be bothered to name — a shop with more than a
 * screen of channel categories does not exist — and because the count each row
 * carries is a correlated subquery that would otherwise be paged separately
 * from the rows it belongs to. The contract pages it anyway so the table
 * component and the mock server see the same shape as every other list.
 */
export async function listCategories(
  ctx: Ctx,
  query: { page: number; pageSize: number },
): Promise<Paged<WechatQrcodeCategory>> {
  requirePermission(ctx, wechatOaPermissions['qrcode:read']);
  const rows = await repo.listQrcodeCategories(ctx.db);
  const offset = (query.page - 1) * query.pageSize;
  return {
    items: rows.slice(offset, offset + query.pageSize).map((row) => ({
      id: toId(row.id),
      name: row.name,
      sortOrder: row.sortOrder,
      qrcodeCount: row.qrcodeCount,
      createdAt: row.createdAt.toISOString(),
    })),
    total: rows.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function createCategory(
  ctx: Ctx,
  body: WechatQrcodeCategoryForm,
): Promise<WechatQrcodeCategory> {
  requirePermission(ctx, wechatOaPermissions['qrcode:write']);
  const row = await insertCategoryOrConflict(ctx, { name: body.name, sortOrder: body.sortOrder });
  return {
    id: toId(row.id),
    name: row.name,
    sortOrder: row.sortOrder,
    qrcodeCount: 0,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function updateCategory(
  ctx: Ctx,
  params: { id: string },
  body: WechatQrcodeCategoryForm,
): Promise<WechatQrcodeCategory> {
  requirePermission(ctx, wechatOaPermissions['qrcode:write']);
  const id = fromId(params.id);
  const { affected } = await categoryNameConflictAsDomainError(() =>
    repo.updateQrcodeCategory(ctx.db, id, {
      name: body.name,
      sortOrder: body.sortOrder,
      now: ctx.clock.now(),
    }),
  );
  if (affected === 0) throw new DomainError('WECHAT_OA_CATEGORY_NOT_FOUND');
  const rows = await repo.listQrcodeCategories(ctx.db);
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new DomainError('WECHAT_OA_CATEGORY_NOT_FOUND');
  return {
    id: toId(row.id),
    name: row.name,
    sortOrder: row.sortOrder,
    qrcodeCount: row.qrcodeCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function insertCategoryOrConflict(
  ctx: Ctx,
  values: { name: string; sortOrder: number },
): Promise<repo.WechatQrcodeCategory> {
  return categoryNameConflictAsDomainError(() => repo.insertQrcodeCategory(ctx.db, values));
}

/**
 * `wechat_qrcode_categories_name_uq` as a 409 instead of a 500.
 *
 * The one way to get here is two people naming a category 地推 at once. The
 * index is scoped to `deleted_at is null`, so a deleted name is free again and
 * the 409 means what it says.
 */
async function categoryNameConflictAsDomainError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!repo.isUniqueViolation(error, 'wechat_qrcode_categories_name_uq')) throw error;
    throw new DomainError('WECHAT_OA_CATEGORY_NAME_TAKEN');
  }
}

export async function deleteCategory(ctx: Ctx, params: { id: string }): Promise<void> {
  requirePermission(ctx, wechatOaPermissions['qrcode:write']);
  const id = fromId(params.id);
  const category = await repo.findQrcodeCategory(ctx.db, id);
  if (!category) throw new DomainError('WECHAT_OA_CATEGORY_NOT_FOUND');
  // Cascading would orphan the codes' attribution, and `set null` would quietly
  // move somebody's channel report into 未分类.
  if ((await repo.countQrcodesInCategory(ctx.db, id)) > 0) {
    throw new DomainError('WECHAT_OA_CATEGORY_NOT_EMPTY');
  }
  await repo.softDeleteQrcodeCategory(ctx.db, id, ctx.clock.now());
}

// ---------------------------------------------------------------------------
// codes
// ---------------------------------------------------------------------------

export async function list(ctx: Ctx, query: WechatQrcodeListQuery): Promise<Paged<WechatQrcode>> {
  requirePermission(ctx, wechatOaPermissions['qrcode:read']);
  const { rows, total } = await repo.listQrcodes(ctx.db, {
    ...(query.categoryId === undefined ? {} : { categoryId: fromId(query.categoryId) }),
    ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.sortBy === undefined ? {} : { sort: query.sortBy }),
    ...(query.sortOrder === undefined ? {} : { order: query.sortOrder }),
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return { items: rows.map(toQrcode), total, page: query.page, pageSize: query.pageSize };
}

export async function detail(ctx: Ctx, params: { id: string }): Promise<WechatQrcode> {
  requirePermission(ctx, wechatOaPermissions['qrcode:read']);
  const row = await repo.findQrcode(ctx.db, fromId(params.id));
  if (!row) throw new DomainError('WECHAT_OA_QRCODE_NOT_FOUND');
  return toQrcode(row);
}

/**
 * Generates the code at WeChat, then records it.
 *
 * That order again: a row with no ticket is a poster nobody can print, and the
 * scene string is burnt either way — so the call comes first and a failure
 * leaves nothing behind.
 */
export async function create(ctx: Ctx, body: WechatQrcodeForm): Promise<WechatQrcode> {
  requirePermission(ctx, wechatOaPermissions['qrcode:write']);
  await requireOaCredentials(ctx);

  if (body.replyType !== undefined) {
    validateReplyPayload(body.replyType, body.replyPayload ?? {});
  }
  if (body.categoryId !== undefined) {
    const category = await repo.findQrcodeCategory(ctx.db, fromId(body.categoryId));
    if (!category) throw new DomainError('WECHAT_OA_CATEGORY_NOT_FOUND');
  }

  const scene = body.scene ?? (await freshScene(ctx));
  if (await repo.sceneTaken(ctx.db, scene)) {
    throw new DomainError('WECHAT_OA_QRCODE_SCENE_TAKEN', { details: { scene } });
  }

  const remote = await createRemoteQrcode(ctx, { scene, expireSeconds: body.expireSeconds });
  const now = ctx.clock.now();

  let row;
  try {
    row = await repo.insertQrcode(ctx.db, {
      ...(body.categoryId === undefined ? {} : { categoryId: fromId(body.categoryId) }),
      name: body.name,
      scene,
      ticket: remote.ticket,
      imageUrl: qrcodeImageUrl(remote.ticket),
      ...(body.expireSeconds > 0
        ? { expiresAt: new Date(now.getTime() + body.expireSeconds * 1000) }
        : {}),
      ...(body.replyType === undefined
        ? {}
        : { replyType: body.replyType, replyPayload: body.replyPayload ?? {} }),
    });
  } catch (error) {
    // The check above is a read and this is the write; between them another
    // operator can take the scene. The index is what decides, and a scene taken
    // twice is two posters reporting into one row — so the refusal has to reach
    // the operator as 该场景值已被占用 rather than as a 500.
    if (!repo.isUniqueViolation(error, 'wechat_qrcodes_scene_uq')) throw error;
    throw new DomainError('WECHAT_OA_QRCODE_SCENE_TAKEN', { details: { scene } });
  }
  const fresh = await repo.findQrcode(ctx.db, row.id);
  return toQrcode(fresh ?? { ...row, categoryName: null });
}

/**
 * Edits the label and the reply. **Never the scene.**
 *
 * The scene is printed on posters that are already on walls; changing it would
 * silently detach every future scan of them from the channel they belong to.
 * A new channel is a new code.
 */
export type WechatQrcodeEditForm = Omit<WechatQrcodeForm, 'scene' | 'expireSeconds'>;

export async function update(
  ctx: Ctx,
  params: { id: string },
  body: WechatQrcodeEditForm,
): Promise<WechatQrcode> {
  requirePermission(ctx, wechatOaPermissions['qrcode:write']);
  const id = fromId(params.id);
  const existing = await repo.findQrcode(ctx.db, id);
  if (!existing) throw new DomainError('WECHAT_OA_QRCODE_NOT_FOUND');

  if (body.replyType !== undefined) {
    validateReplyPayload(body.replyType, body.replyPayload ?? {});
  }
  if (body.categoryId !== undefined) {
    const category = await repo.findQrcodeCategory(ctx.db, fromId(body.categoryId));
    if (!category) throw new DomainError('WECHAT_OA_CATEGORY_NOT_FOUND');
  }

  await repo.updateQrcode(ctx.db, id, {
    categoryId: body.categoryId === undefined ? null : fromId(body.categoryId),
    name: body.name,
    replyType: body.replyType ?? null,
    replyPayload: body.replyType === undefined ? null : (body.replyPayload ?? {}),
    now: ctx.clock.now(),
  });
  const fresh = await repo.findQrcode(ctx.db, id);
  return toQrcode(fresh ?? existing);
}

export async function setStatus(
  ctx: Ctx,
  params: { id: string },
  body: WechatQrcodeStatusBody,
): Promise<WechatQrcode> {
  requirePermission(ctx, wechatOaPermissions['qrcode:write']);
  const id = fromId(params.id);
  const { affected } = await repo.updateQrcode(ctx.db, id, {
    status: body.status,
    now: ctx.clock.now(),
  });
  if (affected === 0) throw new DomainError('WECHAT_OA_QRCODE_NOT_FOUND');
  const row = await repo.findQrcode(ctx.db, id);
  if (!row) throw new DomainError('WECHAT_OA_QRCODE_NOT_FOUND');
  return toQrcode(row);
}

/**
 * Soft delete only.
 *
 * WeChat has no "delete this QR code" endpoint at all: a printed poster keeps
 * working forever. The row stays so the scans it already attracted keep their
 * attribution and so the scene string is never handed to a second code.
 */
export async function remove(ctx: Ctx, params: { id: string }): Promise<void> {
  requirePermission(ctx, wechatOaPermissions['qrcode:write']);
  const { affected } = await repo.softDeleteQrcode(ctx.db, fromId(params.id), ctx.clock.now());
  if (affected === 0) throw new DomainError('WECHAT_OA_QRCODE_NOT_FOUND');
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;

export async function statistic(
  ctx: Ctx,
  params: { id: string },
  query: WechatQrcodeStatQuery,
): Promise<WechatQrcodeStatistic> {
  requirePermission(ctx, wechatOaPermissions['qrcode:read']);
  const id = fromId(params.id);
  const row = await repo.findQrcode(ctx.db, id);
  if (!row) throw new DomainError('WECHAT_OA_QRCODE_NOT_FOUND');

  const now = ctx.clock.now();
  const to = query.to === undefined ? now : endOfDay(query.to);
  const from =
    query.from === undefined
      ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 3600 * 1000)
      : startOfDay(query.from);

  const [points, uniqueScanners] = await Promise.all([
    repo.qrcodeStatPoints(ctx.db, { qrcodeId: id, from, to }),
    repo.countUniqueScanners(ctx.db, id),
  ]);

  return {
    qrcodeId: toId(row.id),
    name: row.name,
    scanCount: row.scanCount,
    followCount: row.followCount,
    uniqueScanners,
    points,
  };
}

export async function scans(
  ctx: Ctx,
  params: { id: string },
  query: { page: number; pageSize: number },
): Promise<Paged<WechatQrcodeScan>> {
  requirePermission(ctx, wechatOaPermissions['qrcode:read']);
  const id = fromId(params.id);
  const row = await repo.findQrcode(ctx.db, id);
  if (!row) throw new DomainError('WECHAT_OA_QRCODE_NOT_FOUND');

  const { rows, total } = await repo.listScans(ctx.db, {
    qrcodeId: id,
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return {
    items: rows.map((scan) => ({
      id: toId(scan.id),
      userId: toIdOrNull(scan.userId),
      nickname: scan.nickname,
      avatar: scan.avatar,
      openid: maskOpenid(scan.openid),
      isNewFollower: scan.isNewFollower,
      createdAt: scan.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A random scene string, retried against the unique index.
 *
 * Random rather than sequential because the scene is visible in the scanned URL
 * and a sequential one tells a competitor how many channels the shop runs and
 * lets them enumerate every poster's reply.
 */
async function freshScene(ctx: Ctx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const scene = `CH_${randomBytes(6)
      .toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()}`;
    if (!(await repo.sceneTaken(ctx.db, scene))) return scene;
  }
  throw new DomainError('INTERNAL', { message: '无法生成唯一的场景值，请重试' });
}

/**
 * An openid identifies a person, and this list is read by anybody with
 * `qrcode:read`. Four characters each end is enough to match two rows by eye
 * and not enough to message them.
 */
export function maskOpenid(openid: string | null): string | null {
  if (openid === null || openid === '') return null;
  if (openid.length <= 8) return `${openid.slice(0, 2)}****`;
  return `${openid.slice(0, 4)}****${openid.slice(-4)}`;
}

/** `YYYY-MM-DD` in Asia/Shanghai, which is where the report is read. */
function startOfDay(date: string): Date {
  return new Date(`${date}T00:00:00+08:00`);
}

function endOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999+08:00`);
}

function toQrcode(row: repo.QrcodeRow): WechatQrcode {
  return {
    id: toId(row.id),
    categoryId: toIdOrNull(row.categoryId),
    categoryName: row.categoryName,
    name: row.name,
    scene: row.scene,
    ticket: row.ticket,
    imageUrl: row.imageUrl,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    replyType: row.replyType,
    replyPayload: (row.replyPayload as WechatReplyPayload | null) ?? null,
    scanCount: row.scanCount,
    followCount: row.followCount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
