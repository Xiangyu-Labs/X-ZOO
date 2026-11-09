import type { DbOrTx, Tx } from '@shop/db';
import type {
  ProductPromotionAdmin,
  ProductPromotionCandidate,
  ProductPromotionInput,
  ProductPromotionSettings,
  StorefrontPromotion,
} from '@shop/contracts/catalog/promotion';
import type { AdminProductDetail } from '@shop/contracts/catalog/schemas';
import { hasPermission } from '../auth';
import { createCtx, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { comboKey } from './catalog.rules';
import * as repo from './catalog.promotion.repo';

type Kind = 'presale' | 'groupbuy';
export interface ProductPromotionPort {
  candidates(
    ctx: Ctx,
    productId: number,
    includeId: number | null,
  ): Promise<ProductPromotionCandidate[]>;
  save(
    ctx: Ctx,
    input: {
      product: AdminProductDetail;
      activityId: string | null;
      settings: ProductPromotionSettings;
    },
  ): Promise<string>;
  end(ctx: Ctx, activityId: string): Promise<void>;
  storefront(ctx: Ctx, activityId: string): Promise<StorefrontPromotion>;
}
const ports = new Map<Kind, ProductPromotionPort>();
export function registerProductPromotionPort(kind: Kind, port: ProductPromotionPort): void {
  ports.set(kind, port);
}
function portOf(kind: Kind): ProductPromotionPort {
  const port = ports.get(kind);
  if (!port) throw new DomainError('CATALOG_PROMOTION_INVALID');
  return port;
}
/** All nested service transactions reuse this handle, never a second pool connection. */
export function promotionTxContext(ctx: Ctx, tx: DbOrTx): Ctx {
  return createCtx({ ...ctx, db: tx as Ctx['db'] });
}
function linkSelection(link: repo.PromotionLink | null): { kind: Kind; activityId: string } | null {
  if (link?.presaleActivityId)
    return { kind: 'presale', activityId: String(link.presaleActivityId) };
  if (link?.groupbuyActivityId)
    return { kind: 'groupbuy', activityId: String(link.groupbuyActivityId) };
  return null;
}
function openCandidate(candidate: ProductPromotionCandidate, now: Date): boolean {
  return (
    candidate.status !== 'ended' &&
    !!candidate.settings &&
    Date.parse(candidate.settings.endAt) > now.getTime()
  );
}
export async function productPromotionState(
  ctx: Ctx,
  productId: number,
): Promise<ProductPromotionAdmin> {
  const link = await repo.findPromotionLink(ctx.db, productId);
  const selection = linkSelection(link);
  const candidates: ProductPromotionCandidate[] = [];
  for (const [kind, port] of ports) {
    candidates.push(
      ...(await port.candidates(
        ctx,
        productId,
        selection?.kind === kind ? Number(selection.activityId) : null,
      )),
    );
  }
  const live = candidates.filter((candidate) => openCandidate(candidate, ctx.clock.now()));
  const current =
    (selection &&
    candidates.some(
      (candidate) =>
        candidate.kind === selection.kind && candidate.activityId === selection.activityId,
    )
      ? selection
      : null) ?? (live.length === 1 ? live[0]! : null);
  return {
    version: link?.version ?? 0,
    mode: current?.kind ?? 'normal',
    activityId: current?.activityId ?? null,
    conflict: live.length > 1,
    candidates,
  };
}
export async function adminProductPromotion(
  ctx: Ctx,
  productId: number,
): Promise<ProductPromotionAdmin> {
  const state = await productPromotionState(ctx, productId);
  return {
    ...state,
    candidates: state.candidates.map((candidate) => {
      if (hasPermission(ctx.actor, `${candidate.kind}:activity:read`)) return candidate;
      const { settings: _settings, ...summary } = candidate;
      return summary;
    }),
  };
}
function requireWrite(ctx: Ctx, kind: Kind): void {
  if (!hasPermission(ctx.actor, `${kind}:activity:write`)) throw new DomainError('FORBIDDEN');
}
export async function lockProductPromotionForWrite(
  ctx: Ctx,
  tx: Tx,
  productId: number,
): Promise<void> {
  if (!hasPermission(ctx.actor, 'catalog:product:write')) throw new DomainError('FORBIDDEN');
  if (!(await repo.lockPromotionProduct(tx, productId)))
    throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');
}
export async function touchProductPromotion(
  ctx: Ctx,
  tx: Tx,
  productId: number,
  kind: Kind,
  activityId: string,
): Promise<void> {
  await repo.touchPromotionLink(tx, productId, kind, Number(activityId), ctx.clock.now());
}
/** Legacy activity APIs share the same product lock and cannot create a second current campaign. */
export async function guardProductPromotionWrite(
  ctx: Ctx,
  tx: Tx,
  productId: number,
  kind: Kind,
  activityId?: string,
): Promise<void> {
  await lockProductPromotionForWrite(ctx, tx, productId);
  const state = await productPromotionState(promotionTxContext(ctx, tx), productId);
  if (
    state.candidates.some(
      (candidate) =>
        openCandidate(candidate, ctx.clock.now()) &&
        (candidate.kind !== kind || candidate.activityId !== activityId),
    )
  ) {
    throw new DomainError('CATALOG_PROMOTION_CONFLICT');
  }
}
export async function associateProductPromotion(
  ctx: Ctx,
  tx: Tx,
  productId: number,
  kind: Kind,
  activityId: string,
): Promise<void> {
  await repo.setPromotionLink(tx, {
    productId,
    kind,
    activityId: Number(activityId),
    now: ctx.clock.now(),
  });
}
export async function saveProductPromotion(
  ctx: Ctx,
  tx: Tx,
  product: AdminProductDetail,
  input: ProductPromotionInput,
): Promise<void> {
  const child = promotionTxContext(ctx, tx);
  const state = await productPromotionState(child, Number(product.id));
  if (input.expectedVersion !== state.version) throw new DomainError('CATALOG_PROMOTION_CHANGED');
  if (input.mode !== 'normal') requireWrite(ctx, input.mode);
  if (state.mode !== 'normal') requireWrite(ctx, state.mode);
  if (state.conflict && input.mode !== 'normal' && !input.activityId)
    throw new DomainError('CATALOG_PROMOTION_CONFLICT');
  const chosen =
    input.mode === 'normal'
      ? undefined
      : state.candidates.find(
          (candidate) =>
            candidate.kind === input.mode &&
            candidate.activityId ===
              (input.activityId ?? (state.mode === input.mode ? state.activityId : null)),
        );
  if (input.activityId && !chosen) throw new DomainError('CATALOG_PROMOTION_CHANGED');
  const settings = input.settings;
  if (input.mode !== 'normal') {
    if (!settings || Date.parse(settings.endAt) <= ctx.clock.now().getTime())
      throw new DomainError('CATALOG_PROMOTION_INVALID');
    const seen = new Set<string>();
    const productKeys = new Set(product.skus.map((sku) => comboKey(sku.specValues)));
    for (const sku of settings.skus) {
      const key = comboKey(sku.specValues);
      if (seen.has(key) || !productKeys.has(key))
        throw new DomainError('CATALOG_PROMOTION_INVALID');
      seen.add(key);
    }
    if (product.skus.some((sku) => sku.isVisible && !seen.has(comboKey(sku.specValues))))
      throw new DomainError('CATALOG_PROMOTION_INVALID');
  }
  const reuse = chosen && openCandidate(chosen, ctx.clock.now());
  for (const candidate of state.candidates) {
    if (candidate.status === 'ended' || (reuse && candidate === chosen)) continue;
    requireWrite(ctx, candidate.kind);
    await portOf(candidate.kind).end(child, candidate.activityId);
  }
  if (input.mode === 'normal') {
    await repo.setPromotionLink(tx, {
      productId: Number(product.id),
      kind: 'normal',
      activityId: null,
      now: ctx.clock.now(),
    });
    return;
  }
  const activityId = await portOf(input.mode).save(child, {
    product,
    activityId: reuse ? chosen.activityId : null,
    settings: settings!,
  });
  await associateProductPromotion(ctx, tx, Number(product.id), input.mode, activityId);
}
export async function storefrontProductPromotion(
  ctx: Ctx,
  productId: number,
): Promise<{ promotion: StorefrontPromotion | null; promotionConflict: boolean }> {
  const state = await productPromotionState(ctx, productId);
  if (state.conflict) return { promotion: null, promotionConflict: true };
  const candidate = state.candidates.find(
    (item) => item.kind === state.mode && item.activityId === state.activityId,
  );
  const settings = candidate?.settings;
  if (
    !candidate ||
    !settings ||
    candidate.status !== 'active' ||
    Date.parse(settings.startAt ?? '') > ctx.clock.now().getTime() ||
    Date.parse(settings.endAt) <= ctx.clock.now().getTime()
  ) {
    return { promotion: null, promotionConflict: false };
  }
  return {
    promotion: await portOf(candidate.kind).storefront(ctx, candidate.activityId),
    promotionConflict: false,
  };
}
/** Order creation calls this under the product lock before locking campaign stock. */
export async function assertProductPromotionPurchase(
  ctx: Ctx,
  db: DbOrTx,
  productIds: readonly number[],
  kind: string,
): Promise<void> {
  const child = promotionTxContext(ctx, db);
  for (const productId of [...new Set(productIds)].sort((a, b) => a - b)) {
    if ('rollback' in db) await repo.lockPromotionProduct(db as Tx, productId);
    const state = await productPromotionState(child, productId);
    if (state.conflict) throw new DomainError('CATALOG_PROMOTION_CONFLICT');
    const candidate = state.candidates.find(
      (item) => item.kind === 'presale' && item.activityId === state.activityId,
    );
    if (
      kind === 'normal' &&
      candidate?.status === 'active' &&
      candidate.settings &&
      Date.parse(candidate.settings.startAt ?? '') <= ctx.clock.now().getTime() &&
      openCandidate(candidate, ctx.clock.now())
    ) {
      throw new DomainError('CATALOG_PRESALE_REQUIRED');
    }
  }
}
