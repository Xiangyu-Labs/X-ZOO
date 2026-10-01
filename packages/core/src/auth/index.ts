/**
 * Authentication and RBAC for both surfaces.
 *
 * - admin: httpOnly cookie -> opaque token -> Redis session (`admin-session.store`)
 * - storefront: `Authorization: Bearer` -> sha256 -> `user_sessions` row
 *
 * Both carry a `passwordVersion` and both are revoked wholesale when a password
 * changes; neither ever stores a token in the clear.
 */
export * from './admin-auth.service';
export * from './admin-session.store';
export * from './api-token.service';
export * as apiTokenRepo from './api-token.repo';
export * as oauth from './oauth.service';
export * from './captcha';
export * from './password';
export * from './permissions';
export * from './rbac';
export * from './user-lookup';
export * from './user-session.service';
export * as adminRepo from './admin.repo';
export { insertAudit, redactPayload, type AuditActorKind, type AuditEntry } from './audit.repo';
export * as userSessionRepo from './user-session.repo';
