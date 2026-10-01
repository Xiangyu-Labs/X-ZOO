import { decorRevisionList } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../../../src/server';

export const GET = handle(decorRevisionList, (ctx, { params }) => decor.listRevisions(ctx, params));

export const dynamic = 'force-dynamic';
