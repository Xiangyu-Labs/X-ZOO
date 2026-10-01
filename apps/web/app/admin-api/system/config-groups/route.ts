import { systemConfigGroupList } from '@shop/contracts/system/system.settings.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/system/config-groups` — the settings index.
 *
 * Groups the caller cannot read are not listed at all: an index of screens you
 * are not allowed to open is just a list of 403s.
 */
export const GET = handle(systemConfigGroupList, (ctx) => system.configGroupList(ctx));

export const dynamic = 'force-dynamic';
