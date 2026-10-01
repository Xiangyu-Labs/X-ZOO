import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Actor, Ctx } from '../kernel/context';
import { anonymousActor, createCtx, systemActor } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fixedClock } from '../kernel/clock';
import { silentLogger } from '../kernel/logger';
import { memoryQueue } from '../kernel/queue';
import { memoryStorage } from '../kernel/storage';
import {
  captchaRequired,
  getCaptchaVerifier,
  registerCaptchaVerifier,
  resetCaptchaVerifier,
} from './captcha';
import {
  allPermissionAtoms,
  authPermissions,
  definePermissions,
  isKnownPermission,
} from './permissions';
import {
  assertPasswordShape,
  hashPassword,
  sha256Hex,
  verifyMd5Legacy,
  verifyPassword,
} from './password';
import {
  effectivePermissions,
  hasEveryPermission,
  hasPermission,
  hasSomePermission,
  IMPLICIT_ADMIN_PERMISSIONS,
  requirePermission,
} from './rbac';
import { readBearer, requireBearer } from './user-session.service';

const admin = (over: Partial<Actor> = {}): Actor => ({
  kind: 'admin',
  id: 1,
  permissions: [],
  isSuper: false,
  ...over,
});

const ctxWith = (actor: Actor): Ctx =>
  createCtx({
    db: {} as never,
    redis: {} as never,
    clock: fixedClock(),
    config: {} as never,
    logger: silentLogger(),
    queue: memoryQueue(),
    storage: memoryStorage(),
    actor,
    platform: null,
    requestId: 'req-1',
  });

describe('definePermissions', () => {
  it('prefixes atoms with the domain and registers a label', () => {
    const atoms = definePermissions('catalog', {
      'product:read': '查看商品',
      'product:update': '编辑商品',
    });
    expect(atoms['product:read']).toBe('catalog:product:read');
    expect(isKnownPermission('catalog:product:update')).toBe(true);
    expect(allPermissionAtoms().some((a) => a.atom === 'catalog:product:read')).toBe(true);
  });

  it('rejects a malformed domain or atom', () => {
    expect(() => definePermissions('Catalog', { 'a:b': 'x' })).toThrow();
    expect(() => definePermissions('catalog', { product: 'x' })).toThrow();
    expect(() => definePermissions('catalog', { 'product:Read': 'x' })).toThrow();
  });

  it('refuses two different labels for one atom', () => {
    definePermissions('dup', { 'a:b': '第一个' });
    expect(() => definePermissions('dup', { 'a:b': '第二个' })).toThrow('重复定义');
    // Same label again is fine — module reloads must not explode.
    expect(() => definePermissions('dup', { 'a:b': '第一个' })).not.toThrow();
  });

  it('declares the own-account atoms the frozen route contracts need', () => {
    expect(authPermissions['session:read']).toBe('auth:session:read');
    expect(authPermissions['session:delete']).toBe('auth:session:delete');
    expect(authPermissions['profile:read']).toBe('auth:profile:read');
    expect(authPermissions['profile:update']).toBe('auth:profile:update');
  });
});

describe('RBAC', () => {
  it('lets a super admin through everything', () => {
    expect(hasPermission(admin({ isSuper: true }), 'catalog:product:delete')).toBe(true);
  });

  it('checks the granted set for a normal admin', () => {
    const actor = admin({ permissions: ['catalog:product:read'] });
    expect(hasPermission(actor, 'catalog:product:read')).toBe(true);
    expect(hasPermission(actor, 'catalog:product:delete')).toBe(false);
  });

  it('has no wildcards and no hierarchy', () => {
    const actor = admin({ permissions: ['catalog:product:*', 'catalog'] });
    expect(hasPermission(actor, 'catalog:product:read')).toBe(false);
  });

  it('grants the own-account atoms to every authenticated admin', () => {
    // An account with an empty role must still reach its own profile and
    // password, or the first login is a dead end.
    expect([...IMPLICIT_ADMIN_PERMISSIONS].sort()).toEqual([
      'auth:api-token:self',
      'auth:profile:read',
      'auth:profile:update',
      'auth:session:delete',
      'auth:session:read',
    ]);
    for (const atom of IMPLICIT_ADMIN_PERMISSIONS) {
      expect(hasPermission(admin(), atom)).toBe(true);
    }
  });

  it('refuses non-admin actors and lets the system actor through', () => {
    expect(hasPermission(anonymousActor, 'auth:session:read')).toBe(false);
    expect(hasPermission({ ...admin(), kind: 'user' }, 'auth:session:read')).toBe(false);
    expect(hasPermission(systemActor, 'anything:at:all')).toBe(true);
  });

  it('combines with every/some', () => {
    const actor = admin({ permissions: ['a:b:c'] });
    expect(hasEveryPermission(actor, ['a:b:c'])).toBe(true);
    expect(hasEveryPermission(actor, ['a:b:c', 'd:e:f'])).toBe(false);
    expect(hasSomePermission(actor, ['a:b:c', 'd:e:f'])).toBe(true);
  });

  it('requirePermission is 401 when anonymous and 403 when merely unprivileged', () => {
    try {
      requirePermission(ctxWith(anonymousActor), 'a:b:c');
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('UNAUTHENTICATED');
    }
    try {
      requirePermission(ctxWith(admin()), 'a:b:c');
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('FORBIDDEN');
      expect((error as DomainError).details).toEqual({ permission: 'a:b:c' });
    }
    expect(() => requirePermission(ctxWith(admin({ isSuper: true })), 'a:b:c')).not.toThrow();
  });

  it('effectivePermissions unions the implicit atoms and sorts', () => {
    expect(effectivePermissions(['z:z:z', 'a:a:a'])).toEqual([
      'a:a:a',
      'auth:api-token:self',
      'auth:profile:read',
      'auth:profile:update',
      'auth:session:delete',
      'auth:session:read',
      'z:z:z',
    ]);
  });
});

describe('passwords', () => {
  it('hashes and verifies with bcrypt', async () => {
    const hash = await hashPassword('xzoo123456', 4);
    expect(hash.startsWith('$2')).toBe(true);
    expect(await verifyPassword('xzoo123456', hash)).toEqual({ ok: true, needsUpgrade: false });
    expect(await verifyPassword('wrong', hash)).toEqual({ ok: false, needsUpgrade: false });
  });

  it('verifies a legacy md5 hash and asks to be upgraded', async () => {
    const md5 = createHash('md5').update('xzoo123456').digest('hex');
    expect(await verifyPassword('xzoo123456', md5, 'md5')).toEqual({
      ok: true,
      needsUpgrade: true,
    });
    expect(await verifyPassword('wrong', md5, 'md5')).toEqual({ ok: false, needsUpgrade: false });
  });

  it('treats a malformed stored hash as a wrong password, not a crash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toEqual({ ok: false, needsUpgrade: false });
    expect(verifyMd5Legacy('x', 'short')).toBe(false);
    expect(await verifyPassword('', '')).toEqual({ ok: false, needsUpgrade: false });
  });

  it('rejects the two shapes bcrypt silently mangles', () => {
    expect(() => assertPasswordShape('')).toThrow();
    expect(() => assertPasswordShape('a'.repeat(73))).toThrow('72');
    expect(() => assertPasswordShape('a'.repeat(72))).not.toThrow();
  });

  it('sha256Hex is the storage form for session tokens', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('bearer parsing', () => {
  it('reads a well-formed header and nothing else', () => {
    expect(readBearer('Bearer abc123')).toBe('abc123');
    expect(readBearer('bearer abc123')).toBe('abc123');
    expect(readBearer('  Bearer   abc123  ')).toBe('abc123');
    for (const bad of [null, undefined, '', 'abc123', 'Basic abc', 'Bearer', 'Bearer a b']) {
      expect(readBearer(bad), String(bad)).toBeNull();
    }
  });

  it('requireBearer throws 401 rather than returning null', () => {
    expect(() => requireBearer(null)).toThrow(DomainError);
    expect(requireBearer('Bearer t')).toBe('t');
  });
});

describe('captcha hook', () => {
  afterEach(() => resetCaptchaVerifier());

  it('is off until something registers a verifier', () => {
    expect(getCaptchaVerifier()).toBeUndefined();
    expect(captchaRequired({ failedAttempts: 99 })).toBe(false);
  });

  it('kicks in after the threshold once registered', () => {
    registerCaptchaVerifier({ name: 'test', verify: async () => true });
    expect(captchaRequired({ failedAttempts: 0 })).toBe(false);
    expect(captchaRequired({ failedAttempts: 3 })).toBe(true);
    expect(captchaRequired({ failedAttempts: 1, threshold: 1 })).toBe(true);
  });
});
