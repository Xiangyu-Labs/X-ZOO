/**
 * The single seam between the admin UI and the contract package: everything the
 * UI needs from contracts is re-exported here.
 */
export { adminLogin, adminLogout, adminMe } from '@shop/contracts/auth/auth.contract';
export { adminProfile as adminIdentity } from '@shop/contracts/auth/schemas';
export type { AdminProfile as AdminIdentity } from '@shop/contracts/auth/schemas';

export { asset, errorBody, id, instant, money, pageQuery, paged } from '@shop/contracts';
export type {
  AnyRouteDef,
  BodyOf,
  ErrorBody,
  ParamsOf,
  QueryOf,
  ResponseOf,
  RouteDef,
} from '@shop/contracts';
