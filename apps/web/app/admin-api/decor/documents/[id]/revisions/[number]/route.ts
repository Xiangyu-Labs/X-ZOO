import { decorRevisionGet } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../../../src/server';

export const GET = handle(decorRevisionGet, (ctx, { params }) => decor.getRevision(ctx, params));

export const dynamic = 'force-dynamic';
