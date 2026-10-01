import { invoiceRequestBody } from '@shop/contracts/order/order.fulfil.schemas';
import {
  invoiceRequestFromTitle,
  invoiceTitleForm,
  type InvoiceTitleForm,
} from '@shop/contracts/user/schemas';
import { admins } from '@shop/db/schema/auth';
import { userInvoiceProfiles } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Ctx } from '../kernel/context';
import type { DomainError } from '../kernel/errors';
import './index';
import * as admin from './user-admin.service';
import * as titles from './invoice-title.service';
import * as repo from './user.repo';
import { INVOICE_TITLE_LIMIT } from './user.rules';
import * as service from './user.service';

/**
 * The 发票抬头 book against a real PostgreSQL 17.
 *
 * What needs the database to mean anything: the owner in every `WHERE`
 * (USER-018), `user_invoice_profiles_default_uq`, the company-needs-duty-number
 * check, and the advisory lock that keeps the cap and the single default true
 * when one customer's writes race (USER-016).
 */

let harness: TestCtx;
let reviewerId = 0;

const NOW = '2026-06-01T00:00:00.000Z';
const WORKERS = 6;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  reviewerId = await makeAdmin();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });

function asUser(id: number): Ctx {
  return harness.as(userActor(id));
}

function forkUser(index: number, id: number): Ctx {
  return forkTestCtx(harness, { actor: userActor(id), requestId: `title-race-${index}` });
}

async function makeAdmin(): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({
      account: `reviewer-${Date.now()}`,
      passwordHash: 'x',
      name: '审核员',
      createdAt: harness.clock.now(),
      updatedAt: harness.clock.now(),
    })
    .returning({ id: admins.id });
  return row!.id;
}

let sequence = 0;

async function makeUser(): Promise<repo.UserRow> {
  sequence += 1;
  const phone = `1370013${String(8000 + sequence).padStart(4, '0')}`;
  const row = await harness.ctx.withTx((tx) =>
    repo.insertUser(tx, {
      account: phone,
      phone,
      passwordHash: null,
      passwordAlgo: null,
      nickname: `用户${sequence}`,
      avatarUrl: null,
      registerSource: 'h5',
      registerIp: null,
      now: harness.clock.now(),
    }),
  );
  if (!row) throw new Error('fixture: insertUser refused');
  return row;
}

/** Parsed through the real schema, so the defaults are the ones a route would see. */
const form = (overrides: Partial<InvoiceTitleForm> = {}): InvoiceTitleForm =>
  invoiceTitleForm.parse({
    headerType: 'company',
    name: '杭州某某科技有限公司',
    dutyNumber: '91330100MA2XXXXX0A',
    ...overrides,
  });

const special = (overrides: Partial<InvoiceTitleForm> = {}): InvoiceTitleForm =>
  form({
    invoiceType: 'special',
    registeredTel: '0571-88888888',
    registeredAddress: '杭州市西湖区文三路 100 号',
    bankName: '中国工商银行杭州分行',
    bankAccount: '1202020209000000000',
    ...overrides,
  });

async function liveDefaults(userId: number): Promise<number[]> {
  const rows = await harness.ctx.db
    .select({ id: userInvoiceProfiles.id })
    .from(userInvoiceProfiles)
    .where(
      and(
        eq(userInvoiceProfiles.userId, userId),
        eq(userInvoiceProfiles.isDefault, true),
        isNull(userInvoiceProfiles.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

function codes(errors: unknown[]): string[] {
  return errors.map((error) => (error as DomainError).code);
}

// ---------------------------------------------------------------------------
// the book
// ---------------------------------------------------------------------------

describe('invoice titles', () => {
  it('saves every field a 专票 needs and reads it back', async () => {
    const user = await makeUser();
    const created = await titles.invoiceTitleCreate(
      asUser(user.id),
      special({ drawerPhone: '13800138000', email: 'finance@example.com' }),
    );

    expect(created).toMatchObject({
      headerType: 'company',
      invoiceType: 'special',
      name: '杭州某某科技有限公司',
      dutyNumber: '91330100MA2XXXXX0A',
      drawerPhone: '13800138000',
      email: 'finance@example.com',
      registeredTel: '0571-88888888',
      registeredAddress: '杭州市西湖区文三路 100 号',
      bankName: '中国工商银行杭州分行',
      bankAccount: '1202020209000000000',
    });
    expect(await titles.invoiceTitleDetail(asUser(user.id), { id: created.id })).toEqual(created);
  });

  it('stores a personal title with nothing but a name, blanks as null', async () => {
    const user = await makeUser();
    const created = await titles.invoiceTitleCreate(
      asUser(user.id),
      form({ headerType: 'personal', name: ' 张三 ', dutyNumber: '', drawerPhone: '  ' }),
    );
    expect(created).toMatchObject({
      headerType: 'personal',
      invoiceType: 'plain',
      name: '张三',
      dutyNumber: null,
      drawerPhone: null,
    });
  });

  it('makes the first one the default whatever the form said', async () => {
    const user = await makeUser();
    const first = await titles.invoiceTitleCreate(asUser(user.id), form({ isDefault: false }));
    expect(first.isDefault).toBe(true);
    const second = await titles.invoiceTitleCreate(asUser(user.id), form({ name: '第二家公司' }));
    expect(second.isDefault).toBe(false);
    expect(await titles.invoiceTitleDefault(asUser(user.id))).toEqual({ title: first });
  });

  it('answers null, not 404, when there is no default', async () => {
    const user = await makeUser();
    expect(await titles.invoiceTitleDefault(asUser(user.id))).toEqual({ title: null });
  });

  it('moves the default on create, on update and on set-default, never leaving two', async () => {
    const user = await makeUser();
    const ctx = asUser(user.id);
    const a = await titles.invoiceTitleCreate(ctx, form({ name: 'A 公司' }));
    const b = await titles.invoiceTitleCreate(ctx, form({ name: 'B 公司', isDefault: true }));
    expect(await liveDefaults(user.id)).toEqual([Number(b.id)]);

    await titles.invoiceTitleUpdate(ctx, { id: a.id }, form({ name: 'A 公司', isDefault: true }));
    expect(await liveDefaults(user.id)).toEqual([Number(a.id)]);

    await titles.invoiceTitleSetDefault(ctx, { id: b.id });
    expect(await liveDefaults(user.id)).toEqual([Number(b.id)]);

    const list = await titles.invoiceTitleList(ctx, { page: 1, pageSize: 20 });
    expect(list.total).toBe(2);
    // The default first, so the picker opens on it.
    expect(list.items.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it('keeps the default flag when the default title is edited', async () => {
    const user = await makeUser();
    const created = await titles.invoiceTitleCreate(asUser(user.id), form());
    const updated = await titles.invoiceTitleUpdate(
      asUser(user.id),
      { id: created.id },
      form({ email: 'invoice@example.com', isDefault: false }),
    );
    expect(updated).toMatchObject({ isDefault: true, email: 'invoice@example.com' });
  });

  it('soft-deletes, frees the default slot, and stops listing it', async () => {
    const user = await makeUser();
    const created = await titles.invoiceTitleCreate(asUser(user.id), form());
    await titles.invoiceTitleDelete(asUser(user.id), { id: created.id });

    expect(await titles.invoiceTitleDefault(asUser(user.id))).toEqual({ title: null });
    expect((await titles.invoiceTitleList(asUser(user.id), { page: 1, pageSize: 20 })).total).toBe(
      0,
    );
    await expect(
      titles.invoiceTitleDetail(asUser(user.id), { id: created.id }),
    ).rejects.toMatchObject({ code: 'USER_INVOICE_TITLE_NOT_FOUND' });
    const replacement = await titles.invoiceTitleCreate(asUser(user.id), form());
    expect(replacement.isDefault).toBe(true);
  });

  it('refuses a 税号 or 专票 field that is only whitespace, naming the field', async () => {
    // The schema's `length > 0` passes "   "; the stored value would be null,
    // which the database check refuses with a 500 — so the service asks again.
    const user = await makeUser();
    await expect(
      titles.invoiceTitleCreate(asUser(user.id), form({ dutyNumber: '   ' })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'body.dutyNumber' }],
    });
    await expect(
      titles.invoiceTitleCreate(asUser(user.id), special({ bankAccount: ' ' })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'body.bankAccount' }],
    });
    expect((await titles.invoiceTitleList(asUser(user.id), { page: 1, pageSize: 20 })).total).toBe(
      0,
    );
  });

  it('USER-016 — refuses a title past the cap of 20', async () => {
    const user = await makeUser();
    for (let i = 0; i < INVOICE_TITLE_LIMIT; i += 1) {
      await titles.invoiceTitleCreate(asUser(user.id), form({ name: `公司 ${i}` }));
    }
    await expect(
      titles.invoiceTitleCreate(asUser(user.id), form({ name: '一家太多' })),
    ).rejects.toMatchObject({
      code: 'USER_INVOICE_TITLE_LIMIT_REACHED',
      details: { limit: INVOICE_TITLE_LIMIT },
    });
    // A deleted title frees its slot.
    const list = await titles.invoiceTitleList(asUser(user.id), { page: 1, pageSize: 1 });
    await titles.invoiceTitleDelete(asUser(user.id), { id: list.items[0]!.id });
    await expect(
      titles.invoiceTitleCreate(asUser(user.id), form({ name: '替补' })),
    ).resolves.toMatchObject({ name: '替补' });
  });

  it('USER-018 — never reads, edits, deletes or promotes another customer’s title', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const title = await titles.invoiceTitleCreate(asUser(owner.id), special());
    const theirs = asUser(stranger.id);

    for (const attempt of [
      () => titles.invoiceTitleDetail(theirs, { id: title.id }),
      () => titles.invoiceTitleUpdate(theirs, { id: title.id }, form({ name: '改掉' })),
      () => titles.invoiceTitleDelete(theirs, { id: title.id }),
      () => titles.invoiceTitleSetDefault(theirs, { id: title.id }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'USER_INVOICE_TITLE_NOT_FOUND' });
    }
    expect((await titles.invoiceTitleList(theirs, { page: 1, pageSize: 20 })).total).toBe(0);
    expect(await titles.invoiceTitleDefault(theirs)).toEqual({ title: null });
    // And the owner's row is exactly as it was.
    expect(await titles.invoiceTitleDetail(asUser(owner.id), { id: title.id })).toEqual(title);
  });

  it('USER-017 — every saved title prefills a request body the invoice route accepts', async () => {
    const user = await makeUser();
    const ctx = asUser(user.id);
    const saved = [
      await titles.invoiceTitleCreate(ctx, form({ headerType: 'personal', name: '张三' })),
      await titles.invoiceTitleCreate(ctx, form({ drawerPhone: '', email: 'a@example.com' })),
      await titles.invoiceTitleCreate(ctx, special()),
    ];
    for (const title of saved) {
      const body = invoiceRequestFromTitle(title);
      const parsed = invoiceRequestBody.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({
        headerType: title.headerType,
        invoiceType: title.invoiceType,
        name: title.name,
      });
    }
  });

  it('wipes the book when a 注销 is approved', async () => {
    const user = await makeUser();
    await titles.invoiceTitleCreate(asUser(user.id), special());
    const request = await service.requestCancellation(asUser(user.id), {});
    await admin.adminApproveCancellation(
      harness.as({ kind: 'admin', id: reviewerId, permissions: [], isSuper: true }),
      { id: request.id },
      {},
    );
    const live = await harness.ctx.db
      .select({ id: userInvoiceProfiles.id })
      .from(userInvoiceProfiles)
      .where(and(eq(userInvoiceProfiles.userId, user.id), isNull(userInvoiceProfiles.deletedAt)));
    expect(live).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// races
// ---------------------------------------------------------------------------

describe('USER-016 — one customer’s title writes, raced', () => {
  it('leaves exactly one default when six titles are promoted at once, and every caller succeeds', async () => {
    const user = await makeUser();
    const created: Array<{ id: string }> = [];
    for (let i = 0; i < WORKERS; i += 1) {
      created.push(await titles.invoiceTitleCreate(asUser(user.id), form({ name: `公司 ${i}` })));
    }

    const report = await runConcurrently(WORKERS, (index) =>
      titles.invoiceTitleSetDefault(forkUser(index, user.id), { id: created[index]!.id }),
    );

    // Queued on the book lock, each promotion wins in turn — none of them
    // dies on the partial unique index.
    expect(codes(report.rejected)).toEqual([]);
    expect(report.fulfilled).toHaveLength(WORKERS);
    const defaults = await liveDefaults(user.id);
    expect(defaults).toHaveLength(1);
    const current = await titles.invoiceTitleDefault(asUser(user.id));
    expect(Number(current.title!.id)).toBe(defaults[0]);
  });

  it('makes exactly one of six simultaneous first titles the default', async () => {
    const user = await makeUser();
    const report = await runConcurrently(WORKERS, (index) =>
      titles.invoiceTitleCreate(forkUser(index, user.id), form({ name: `公司 ${index}` })),
    );
    expect(codes(report.rejected)).toEqual([]);
    expect(report.fulfilled.filter((t) => t.isDefault)).toHaveLength(1);
    expect(await liveDefaults(user.id)).toHaveLength(1);
  });

  it('lets exactly the free slots through when six creates race the cap', async () => {
    const user = await makeUser();
    const FREE = 2;
    for (let i = 0; i < INVOICE_TITLE_LIMIT - FREE; i += 1) {
      await titles.invoiceTitleCreate(asUser(user.id), form({ name: `公司 ${i}` }));
    }

    const report = await runConcurrently(WORKERS, (index) =>
      titles.invoiceTitleCreate(forkUser(index, user.id), form({ name: `抢位 ${index}` })),
    );

    expect(report.fulfilled).toHaveLength(FREE);
    expect(codes(report.rejected)).toEqual(
      Array.from({ length: WORKERS - FREE }, () => 'USER_INVOICE_TITLE_LIMIT_REACHED'),
    );
    const list = await titles.invoiceTitleList(asUser(user.id), { page: 1, pageSize: 50 });
    expect(list.total).toBe(INVOICE_TITLE_LIMIT);
  });
});
