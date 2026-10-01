import type { DbOrTx } from '@shop/db';
import { auditLogs } from '@shop/db/schema/auth';
import { allConfigGroups, type ConfigFieldUi } from '../kernel/config-registry';

/** The only file that touches `audit_logs`. */

export type AuditActorKind = 'admin' | 'staff';

export interface AuditEntry {
  /**
   * Defaults to `admin`. `staff` (the 店员 named in `userId`) is only on rows
   * written before the cutover deleted the mobile staff console.
   */
  actorKind?: AuditActorKind;
  adminId: number | null;
  userId?: number | null;
  /** The API token the admin acted through; absent for the console. */
  apiTokenId?: number | null;
  adminAccount: string;
  routeId: string;
  method: string;
  path: string;
  target?: string | null;
  status: number;
  payload?: unknown;
  requestId: string;
  ip?: string | null;
  now: Date;
}

/**
 * Keys that must never reach the operation log, whatever route sent them.
 *
 * This is the backstop. The primary source is the config registry: every field
 * a group marks `secret: true` or `type: 'password'` is stripped by name too
 * (`PUT /admin-api/system/config/payment` nests `merchantPrivateKey` under
 * `values`, a name no hand-kept list would think of). Matching is
 * case-insensitive.
 */
const STRIP = [
  'password',
  'oldPassword',
  'newPassword',
  'passwordHash',
  'token',
  'captchaToken',
  'secret',
  'appSecret',
  'apiV3Key',
  'privateKey',
];

/** Anything named like a credential, for keys neither list knows. */
const CREDENTIAL_NAME = /passw(or)?d|secret|private_?key|api_?v3_?key/i;

/** Deep enough for every body we accept; deeper than this is not a sentence. */
const MAX_DEPTH = 8;

const REDACTED = '[redacted]';

function secretKeys(): Set<string> {
  const keys = new Set(STRIP.map((key) => key.toLowerCase()));
  for (const group of allConfigGroups()) {
    for (const [key, ui] of Object.entries(group.ui as Record<string, ConfigFieldUi | undefined>)) {
      if (ui?.secret || ui?.type === 'password') keys.add(key.toLowerCase());
    }
  }
  return keys;
}

function redactValue(value: unknown, keys: Set<string>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, keys, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      keys.has(key.toLowerCase()) || CREDENTIAL_NAME.test(key)
        ? [key, REDACTED]
        : [key, redactValue(entry, keys, depth + 1)],
    ),
  );
}

/**
 * Recursive redaction (objects and arrays, to a depth cap) plus a hard size
 * cap: an audit row is a sentence, not a dump. The audit log is read by more
 * people than hold the credentials, so a secret at any depth is replaced.
 */
export function redactPayload(payload: unknown, limit = 4000): string | null {
  if (payload === undefined || payload === null) return null;
  const value = redactValue(payload, secretKeys(), 0);
  try {
    const json = JSON.stringify(value);
    return json.length > limit ? `${json.slice(0, limit)}…` : json;
  } catch {
    return null;
  }
}

export async function insertAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorKind: entry.actorKind ?? 'admin',
    adminId: entry.adminId,
    userId: entry.userId ?? null,
    apiTokenId: entry.apiTokenId ?? null,
    adminAccount: entry.adminAccount.slice(0, 64),
    routeId: entry.routeId,
    method: entry.method,
    path: entry.path.slice(0, 512),
    target: entry.target ?? null,
    status: entry.status,
    payload: redactPayload(entry.payload),
    requestId: entry.requestId,
    ip: entry.ip ?? null,
    createdAt: entry.now,
  });
}
