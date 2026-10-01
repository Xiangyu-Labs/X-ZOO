import { authApiTokenCreate, authApiTokenList } from '@shop/contracts/auth/auth.api-token.contract';
import { createPersonalToken, listTokens } from '@shop/core/auth';
import { handle } from '../../../src/server';

/**
 * `/admin-api/api-tokens` — the tokens an AI agent or the CLI acts with.
 * Console sessions only: the service refuses a request made with a token.
 */
export const GET = handle(authApiTokenList, (ctx) => listTokens(ctx));

export const POST = handle(authApiTokenCreate, async (ctx, { body }) => {
  const created = await createPersonalToken(ctx, body);
  ctx.audit(`api-token:${created.item.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
