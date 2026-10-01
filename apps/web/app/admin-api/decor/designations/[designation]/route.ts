import { decorDesignate } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../src/server';

/** Sets or clears the 首页 / 个人中心. */
export const PUT = handle(decorDesignate, async (ctx, { params, body }) => {
  const result = await decor.designate(ctx, { ...params, ...body });
  ctx.audit(`decor:designation:${params.designation}`);
  return result;
});

export const dynamic = 'force-dynamic';
