import { adminMe } from '@shop/contracts/auth/auth.contract';
import { getContainer, handle } from '../../../../src/server';

/**
 * The admin shell calls this once on boot to render the menu and to decide
 * what `<Can>` lets through. Permissions come from the session, so this costs
 * one row read and no permission join.
 */
export const GET = handle(adminMe, (ctx) => getContainer().adminAuth.me(ctx));

export const dynamic = 'force-dynamic';
