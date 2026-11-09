import type { DbOrTx, Tx } from '@shop/db';
import { productPromotions } from '@shop/db/schema/catalog-promotion';
import { products } from '@shop/db/schema/catalog';
import { eq, sql } from 'drizzle-orm';
import { lockRow } from '../kernel/tx';

export type PromotionLink = typeof productPromotions.$inferSelect;
export const lockPromotionProduct = (tx: Tx, productId: number) => lockRow(tx, products, productId);
export async function findPromotionLink(db: DbOrTx, productId: number) {
  const [row] = await db
    .select()
    .from(productPromotions)
    .where(eq(productPromotions.productId, productId));
  return row ?? null;
}
export async function setPromotionLink(
  tx: Tx,
  input: {
    productId: number;
    kind: 'presale' | 'groupbuy' | 'normal';
    activityId: number | null;
    now: Date;
  },
) {
  const values = {
    presaleActivityId: input.kind === 'presale' ? input.activityId : null,
    groupbuyActivityId: input.kind === 'groupbuy' ? input.activityId : null,
    updatedAt: input.now,
  };
  await tx
    .insert(productPromotions)
    .values({ productId: input.productId, ...values })
    .onConflictDoUpdate({
      target: productPromotions.productId,
      set: { ...values, version: sql`${productPromotions.version} + 1` },
    });
}
export async function touchPromotionLink(
  tx: Tx,
  productId: number,
  kind: 'presale' | 'groupbuy',
  activityId: number,
  now: Date,
): Promise<void> {
  const column =
    kind === 'presale' ? productPromotions.presaleActivityId : productPromotions.groupbuyActivityId;
  await tx
    .update(productPromotions)
    .set({ version: sql`${productPromotions.version} + 1`, updatedAt: now })
    .where(sql`${productPromotions.productId} = ${productId} and ${column} = ${activityId}`);
}
