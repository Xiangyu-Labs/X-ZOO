import { decorDesignations } from '@shop/contracts/decor/decor.admin.contract';
import * as decor from '@shop/core/decor';
import { handle } from '../../../../src/server';

export const GET = handle(decorDesignations, (ctx) => decor.getDesignations(ctx));

export const dynamic = 'force-dynamic';
