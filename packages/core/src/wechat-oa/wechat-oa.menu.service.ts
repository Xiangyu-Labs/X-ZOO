import type {
  WechatMenu,
  WechatMenuButtonShape,
  WechatMenuForm,
} from '@shop/contracts/wechat-oa/schemas';
import { requirePermission } from '../auth/rbac';
import type { Ctx } from '../kernel/context';
import { summaryOf, UNEXPLAINED } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import { wechatErrcodeHint } from '../wechat';
import { publishMenu as publishRemoteMenu } from './wechat-oa.client';
import { requireOaCredentials } from './wechat-oa.credentials';
import { wechatOaPermissions } from './permissions';
import * as repo from './wechat-oa.repo';

/**
 * The bottom menu, as a draft-and-publish pair.
 *
 * A menu POSTed to WeChat on save would make "what is live" and "what is in the
 * box" the same thing, and a half-finished edit would reach every follower. So
 * a menu is a row, editing it changes nothing anyone sees, and `publish` is the
 * moment it goes live — recorded on the row as `published_at`, with WeChat's
 * own complaint kept in `publish_error` when it refuses, and what staff read
 * about it, in Chinese, in `publish_error_summary`.
 */

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The structural rules WeChat enforces, enforced here first.
 *
 * Sending an invalid tree costs a round trip and comes back as
 * `40017 invalid button type` with no indication of *which* button — so the
 * check runs locally and names the path. The rules are WeChat's, not ours:
 * three top-level buttons, five children, a parent has no action, a `view`
 * needs a URL, a `click` needs a key, a `miniprogram` needs both an appid and
 * a page.
 */
export function validateMenuTree(buttons: readonly WechatMenuButtonShape[]): void {
  if (buttons.length === 0 || buttons.length > 3) {
    throw new DomainError('WECHAT_OA_MENU_INVALID', {
      message: '一级菜单需要 1 到 3 个按钮',
    });
  }
  buttons.forEach((button, index) => validateButton(button, `${index + 1}`, true));
}

function validateButton(button: WechatMenuButtonShape, path: string, top: boolean): void {
  const children = button.sub_button ?? [];
  const fail = (message: string): never => {
    throw new DomainError('WECHAT_OA_MENU_INVALID', { message: `菜单「${path}」${message}` });
  };

  if (button.name.trim() === '') fail('缺少名称');

  if (children.length > 0) {
    if (!top) fail('二级菜单不能再有子菜单');
    if (children.length > 5) fail('最多只能有 5 个子菜单');
    // A parent button is a label. WeChat ignores any action on it, which is how
    // an operator ends up convinced the URL "does not work".
    if (button.type !== undefined) fail('含子菜单时不能再设置动作类型');
    children.forEach((child, index) => validateButton(child, `${path}-${index + 1}`, false));
    return;
  }

  switch (button.type) {
    case 'view':
      if (!button.url?.trim()) fail('缺少跳转链接');
      break;
    case 'click':
      if (!button.key?.trim()) fail('缺少 key');
      break;
    case 'miniprogram':
      if (!button.appid?.trim()) fail('缺少小程序 appid');
      if (!button.pagepath?.trim()) fail('缺少小程序页面路径');
      if (!button.url?.trim()) fail('缺少低版本客户端的兜底链接');
      break;
    default:
      fail('缺少动作类型');
  }
}

export async function list(
  ctx: Ctx,
  query: { page: number; pageSize: number },
): Promise<Paged<WechatMenu>> {
  requirePermission(ctx, wechatOaPermissions['menu:read']);
  const { rows, total } = await repo.listMenus(ctx.db, {
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return { items: rows.map(toMenu), total, page: query.page, pageSize: query.pageSize };
}

/** The live menu, or `null` when nothing has been published yet. */
export async function current(ctx: Ctx): Promise<WechatMenu | null> {
  requirePermission(ctx, wechatOaPermissions['menu:read']);
  const row = await repo.findActiveMenu(ctx.db);
  return row ? toMenu(row) : null;
}

export async function create(ctx: Ctx, body: WechatMenuForm): Promise<WechatMenu> {
  requirePermission(ctx, wechatOaPermissions['menu:write']);
  validateMenuTree(body.buttons);
  const row = await repo.insertMenu(ctx.db, { name: body.name, buttons: [...body.buttons] });
  return toMenu(row);
}

export async function update(
  ctx: Ctx,
  params: { id: string },
  body: WechatMenuForm,
): Promise<WechatMenu> {
  requirePermission(ctx, wechatOaPermissions['menu:write']);
  validateMenuTree(body.buttons);
  const id = fromId(params.id);
  const { affected } = await repo.updateMenu(ctx.db, id, {
    name: body.name,
    buttons: [...body.buttons],
    now: ctx.clock.now(),
  });
  if (affected === 0) throw new DomainError('WECHAT_OA_MENU_NOT_FOUND');

  // An edit to the live menu does not reach WeChat: publishing is a separate
  // permission and a separate decision. The row stays `is_active` and the
  // operator sees "已发布" next to a draft that has moved on — which is the
  // truth, and the publish button is right there.
  const row = await repo.findMenu(ctx.db, id);
  if (!row) throw new DomainError('WECHAT_OA_MENU_NOT_FOUND');
  return toMenu(row);
}

export async function remove(ctx: Ctx, params: { id: string }): Promise<void> {
  requirePermission(ctx, wechatOaPermissions['menu:write']);
  const id = fromId(params.id);
  const row = await repo.findMenu(ctx.db, id);
  if (!row) throw new DomainError('WECHAT_OA_MENU_NOT_FOUND');
  // The live menu cannot be deleted: the row is the only record of what the
  // followers are looking at.
  if (row.isActive) {
    throw new DomainError('WECHAT_OA_MENU_INVALID', { message: '已发布的菜单不能删除' });
  }
  await repo.softDeleteMenu(ctx.db, id, ctx.clock.now());
}

/**
 * Sends the tree to WeChat and, only if WeChat accepts it, marks the row live.
 *
 * The order matters. Marking first and calling second leaves a row saying
 * 已发布 for a menu the followers never saw whenever the call fails — and it
 * fails often, because WeChat validates URLs against the account's own
 * 业务域名. Calling first means a failure changes nothing except
 * `publish_error`, which is exactly what an operator needs to read.
 */
export async function publish(ctx: Ctx, params: { id: string }): Promise<WechatMenu> {
  requirePermission(ctx, wechatOaPermissions['menu:publish']);
  await requireOaCredentials(ctx);

  const id = fromId(params.id);
  const row = await repo.findMenu(ctx.db, id);
  if (!row) throw new DomainError('WECHAT_OA_MENU_NOT_FOUND');
  validateMenuTree(row.buttons);

  try {
    await publishRemoteMenu(ctx, row.buttons);
  } catch (error) {
    await repo.recordMenuPublishError(ctx.db, id, describePublishError(error), ctx.clock.now());
    throw error;
  }

  await activate(ctx, id);
  const fresh = await repo.findMenu(ctx.db, id);
  return toMenu(fresh ?? row);
}

/**
 * Marks the row live, retrying once if another publish got there first.
 *
 * `activateMenu` clears every `is_active` and then sets this one, in one
 * transaction. When no menu is active yet the first statement matches no rows
 * and therefore locks nothing, so two operators publishing at the same moment
 * both reach the second statement and the partial unique index
 * `wechat_oa_menus_active_uq` rejects the later one. The rejection is not the
 * truth of the situation: WeChat has already accepted this menu, it *is* what
 * the followers see, and the row must say so. On the second attempt the
 * winner's row is visible and committed, the clearing statement finds it, locks
 * it, and this publish wins the way a later publish always should.
 *
 * Once, not in a loop: the retry can only lose again if a third publish
 * committed in between, and at that point the operator clicking last is no
 * longer the one whose menu should be live.
 */
async function activate(ctx: Ctx, id: number): Promise<void> {
  try {
    await ctx.withTx((tx) => repo.activateMenu(tx, id, ctx.clock.now()));
  } catch (error) {
    if (!repo.isUniqueViolation(error, 'wechat_oa_menus_active_uq')) throw error;
    ctx.logger.warn({ menuId: id }, 'menu activate lost a race; retrying once');
    await ctx.withTx((tx) => repo.activateMenu(tx, id, ctx.clock.now()));
  }
}

/**
 * The menu-specific refusals of `cgi-bin/menu/create`, in the operator's words.
 * The local check (`validateMenuTree`) catches most structural ones first; what
 * is left is mostly WeChat's view of the URLs and of the account itself.
 */
const MENU_CODES: Record<number, string> = {
  40016: '一级菜单的按钮数量不符合微信的要求',
  40017: '菜单里有按钮的类型不对',
  40018: '一级菜单的按钮名称太长',
  40019: '一级菜单的按钮 key 太长',
  40020: '一级菜单的跳转链接太长',
  40023: '子菜单的数量不符合微信的要求',
  40024: '子菜单里有按钮的类型不对',
  40025: '子菜单的按钮名称太长',
  40026: '子菜单的按钮 key 太长',
  40027: '子菜单的跳转链接太长',
  40054: '子菜单的跳转链接不是有效的网址，请检查是否以 https:// 开头',
  40055: '一级菜单的跳转链接不是有效的网址，请检查是否以 https:// 开头',
  48001: '这个公众号没有自定义菜单接口的权限（未认证的订阅号不能通过接口发布菜单）',
};

/**
 * A refused publish as the row records it: the raw text for 技术详情, and the
 * Chinese line staff read (AGENTS.md rule 1). WeChat's number is in both, for
 * whoever they ask for help. WeChat's `errmsg` is logged, never stored (the client).
 */
function describePublishError(error: unknown): { error: string; summary: string } {
  const errcode = errcodeOf(error);
  const raw = error instanceof Error ? error.message : String(error);
  if (errcode === null) {
    return { error: raw, summary: summaryOf(error) ?? `菜单没有发布成功，${UNEXPLAINED}` };
  }
  const known = MENU_CODES[errcode] ?? wechatErrcodeHint(errcode);
  return {
    error: raw,
    summary: known
      ? `${known}（错误码 ${errcode}）`
      : `微信没有接受这套菜单（错误码 ${errcode}），${UNEXPLAINED}`,
  };
}

/** WeChat's errcode, which `expectOk` and the token refresh put in `details`. */
function errcodeOf(error: unknown): number | null {
  if (!(error instanceof DomainError)) return null;
  const code = (error.details as { errcode?: unknown } | undefined)?.errcode;
  return typeof code === 'number' && code !== 0 ? code : null;
}

function toMenu(row: repo.WechatOaMenu): WechatMenu {
  return {
    id: toId(row.id),
    name: row.name,
    buttons: row.buttons as WechatMenu['buttons'],
    isActive: row.isActive,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishError: row.publishError,
    // A refusal recorded before summaries were written has only the raw text.
    publishErrorSummary:
      row.publishError === null
        ? null
        : (row.publishErrorSummary ?? `菜单没有发布成功，${UNEXPLAINED}`),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
