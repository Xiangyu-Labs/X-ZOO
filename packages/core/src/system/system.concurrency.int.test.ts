import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { admins } from '@shop/db/schema/auth';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { createAdminSessionStore } from '../auth/admin-session.store';
import type { Actor, Ctx } from '../kernel/context';
import type { DomainError } from '../kernel/errors';
import { adminCreate, adminDelete, adminSetStatus, configureAdminPasswords } from './admin.service';
import { roleCreate, roleDelete, roleSetStatus } from './role.service';
import './index';

/**
 * Every conditional state change in `system`, raced.
 *
 * Each of these is guarded inside the statement rather than by a prior read, so
 * the interesting question is not "does it work" but "how many callers believe
 * they were the one who changed it" — a second winner here is a second session
 * revocation report, a second audit row, and an operator who cannot tell what
 * actually happened.
 */

let harness: TestCtx;
let superId: number;

const NOW = '2026-09-22T08:00:00.000Z';
const WORKERS = 6;
const BCRYPT_COST = 4;

function actor(id: number): Actor {
  return { kind: 'admin', id, permissions: [], isSuper: true };
}

/** A context with its own connection, so the callers really contend. */
function fork(index: number): Ctx {
  return forkTestCtx(harness, { actor: actor(superId), requestId: `race-${index}` });
}

async function seedAdmin(account: string): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({ account, passwordHash: 'x', passwordAlgo: 'bcrypt', name: account })
    .returning({ id: admins.id });
  return row!.id;
}

async function seedSession(adminId: number): Promise<void> {
  const store = createAdminSessionStore({ redis: harness.ctx.redis });
  await store.create(
    {
      adminId,
      account: `session-${adminId}`,
      name: `session-${adminId}`,
      avatar: null,
      isSuper: false,
      permissions: [],
      passwordVersion: 0,
    },
    harness.ctx.clock.nowMs(),
  );
}

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
  configureAdminPasswords({ bcryptCost: BCRYPT_COST });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  superId = await seedAdmin('root');
  await harness.ctx.db.update(admins).set({ isSuper: true });
});

describe('disabling an account', () => {
  it('lets exactly one of six disables claim the session revocation', async () => {
    // Six operators click 禁用 on the same row. The UPDATE is guarded on the
    // previous status, so only the caller that flipped it reports the kill.
    const victim = await seedAdmin('victim');
    await seedSession(victim);

    const report = await runConcurrently(
      WORKERS,
      (index) => adminSetStatus(fork(index), { id: String(victim) }, { enabled: false }),
      { isWinner: (result) => result.revokedSessions > 0 },
    );

    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(1);
    expect(report.losers).toBe(WORKERS - 1);
    // And every caller reads back the same, settled answer.
    for (const result of report.fulfilled) expect(result.admin.enabled).toBe(false);

    const store = createAdminSessionStore({ redis: harness.ctx.redis });
    expect(await store.countFor(victim)).toBe(0);
  });
});

describe('deleting an account', () => {
  it('lets exactly one of six deletions win', async () => {
    const victim = await seedAdmin('victim');

    const report = await runConcurrently(WORKERS, (index) =>
      adminDelete(fork(index), { id: String(victim) }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(WORKERS - 1);
    for (const error of report.rejected) {
      expect((error as DomainError).code).toBe('SYSTEM_ADMIN_NOT_FOUND');
    }
  });
});

describe('creating an account', () => {
  it('lets the unique index, not the pre-check, settle six identical creates', async () => {
    // The pre-read cannot see a row a sibling transaction has not committed, so
    // this passes only because the insert maps the unique violation.
    const form = {
      account: 'editor',
      name: '内容编辑',
      password: 'xzoo-123456',
      enabled: true,
      roleIds: [] as string[],
    };

    const report = await runConcurrently(WORKERS, (index) => adminCreate(fork(index), form));

    expect(report.fulfilled).toHaveLength(1);
    for (const error of report.rejected) {
      expect((error as DomainError).code).toBe('SYSTEM_ADMIN_ACCOUNT_TAKEN');
    }
    const rows = await harness.ctx.db.select().from(admins);
    expect(rows.filter((r) => r.account === 'editor')).toHaveLength(1);
  });
});

describe('roles', () => {
  it('lets exactly one of six deletions of the same role win', async () => {
    const role = await roleCreate(harness.ctx.as(actor(superId)), {
      name: '客服',
      enabled: true,
      permissions: [],
    });

    const report = await runConcurrently(WORKERS, (index) =>
      roleDelete(fork(index), { id: role.id }),
    );

    expect(report.fulfilled).toHaveLength(1);
    expect(report.rejected).toHaveLength(WORKERS - 1);
    for (const error of report.rejected) {
      // Gone, not "in use by 0 admins" — the loser re-read before answering.
      expect((error as DomainError).code).toBe('SYSTEM_ROLE_NOT_FOUND');
    }
  });

  it('never deletes a role that a concurrent admin edit just granted', async () => {
    // The `not exists` lives inside the DELETE, so the two orderings are the
    // only two outcomes: the role is gone and the grant failed, or the grant
    // landed and the deletion was refused as in use.
    const ctx = harness.ctx.as(actor(superId));
    const role = await roleCreate(ctx, { name: '客服', enabled: true, permissions: [] });

    const [deletion, creation] = await Promise.allSettled([
      roleDelete(fork(1), { id: role.id }),
      adminCreate(fork(2), {
        account: 'agent',
        name: '客服甲',
        password: 'xzoo-123456',
        enabled: true,
        roleIds: [role.id],
      }),
    ]);

    if (deletion.status === 'fulfilled') {
      // The role is gone, so the grant must not have been written against it.
      expect(creation.status).toBe('rejected');
    } else {
      expect((deletion.reason as DomainError).code).toBe('SYSTEM_ROLE_IN_USE');
      expect(creation.status).toBe('fulfilled');
    }
  });

  it('lets exactly one of six disables of a role revoke its holders', async () => {
    const ctx = harness.ctx.as(actor(superId));
    const role = await roleCreate(ctx, { name: '客服', enabled: true, permissions: [] });
    const holder = await adminCreate(ctx, {
      account: 'agent',
      name: '客服甲',
      password: 'xzoo-123456',
      enabled: true,
      roleIds: [role.id],
    });
    await seedSession(Number(holder.admin.id));

    const report = await runConcurrently(WORKERS, (index) =>
      roleSetStatus(fork(index), { id: role.id }, { enabled: false }),
    );

    expect(report.rejected).toEqual([]);
    for (const result of report.fulfilled) expect(result.enabled).toBe(false);
    // Whoever flipped the row did the revocation, and it happened exactly once —
    // the holder has no sessions left.
    const store = createAdminSessionStore({ redis: harness.ctx.redis });
    expect(await store.countFor(Number(holder.admin.id))).toBe(0);
  });
});
