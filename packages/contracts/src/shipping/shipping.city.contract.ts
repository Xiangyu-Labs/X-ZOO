import { defineRoute } from '../_conventions/route';
import { cityTree, cityTreeExample } from './schemas';

/**
 * The administrative-division tree — read-only, on both surfaces.
 *
 * There are no writes. `cities` is **seed data** (about 3200 rows,
 * `packages/db/seed-data/cities.json`) that the whole shop's freight rules and
 * address snapshots key on; letting an operator rename or delete a division at
 * runtime is how a freight region quietly stops matching, and a cached tree
 * then needs someone to remember to clear it.
 *
 * So: the tree is immutable, the response carries a `version` fingerprint, and
 * there is no cache to bust (CITY-001).
 */

export const cityTreePublic = defineRoute({
  id: 'shipping.cityTree',
  method: 'GET',
  path: '/api/v1/cities',
  auth: 'public',
  summary: '省市区三级地区树',
  tags: ['shipping'],
  response: cityTree,
  examples: [{ name: 'ok', response: cityTreeExample }],
});

/**
 * The same tree for the 运费模板 region picker. A separate route only because
 * the admin surface needs a permission and the storefront one must stay public
 * for the address form; the body is byte-identical.
 */
export const cityTreeAdmin = defineRoute({
  id: 'shipping.adminCityTree',
  method: 'GET',
  path: '/admin-api/shipping/cities',
  auth: 'admin',
  permission: 'shipping:template:read',
  summary: '地区树（后台）',
  tags: ['shipping'],
  response: cityTree,
  examples: [{ name: 'ok', response: cityTreeExample }],
});
