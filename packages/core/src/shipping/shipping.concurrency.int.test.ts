import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ShippingTemplateForm } from '@shop/contracts/shipping/schemas';
import { cities } from '@shop/db/schema/reference';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';

import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import * as express from './shipping.express.service';
import * as templates from './shipping.template.service';

/**
 * One race per conditional state change in `shipping`.
 *
 * `docs/conventions.md`: "Every conditional state change ships a concurrency
 * test using `runConcurrently`." There are three here — the soft delete's "not
 * already deleted", the template aggregate's delete-then-insert of its child
 * rows, and the courier code's unique index — and each is a read-then-write
 * that every sequential test in `shipping.int.test.ts` passes happily.
 *
 * `forkTestCtx` gives the second operator its own `Ctx`, so the two collide on
 * the row rather than queueing behind one session.
 */

let harness: TestCtx;
let other: Ctx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  await harness.ctx.db.insert(cities).values([
    { id: 330000, parentId: null, level: 0, name: '浙江' },
    { id: 330100, parentId: 330000, level: 1, name: '杭州市' },
    { id: 110000, parentId: null, level: 0, name: '北京' },
  ]);
  // A second operator, on its own context: two people clicking at once.
  other = forkTestCtx(harness);
});

/** Alternates between the two independent contexts. */
const ctxFor = (index: number): Ctx => (index % 2 === 0 ? harness.ctx : other);

function form(overrides: Partial<ShippingTemplateForm> = {}): ShippingTemplateForm {
  return {
    name: '模板',
    chargeMode: 'quantity',
    hasFreeRules: false,
    hasNoDeliveryRules: false,
    sortOrder: 0,
    regions: [
      {
        isFallback: true,
        cityIds: [],
        firstUnit: 1,
        firstPrice: '10.00',
        additionalUnit: 1,
        additionalPrice: '5.00',
      },
    ],
    freeRules: [],
    noDeliveryCityIds: [],
    ...overrides,
  };
}

const codeOf = (error: unknown): string | undefined =>
  error instanceof DomainError ? error.code : undefined;

// ---------------------------------------------------------------------------
// the soft delete
// ---------------------------------------------------------------------------

describe('deleting one template from two screens at once', () => {
  it('deletes it once and tells the loser it is gone', async () => {
    const created = await templates.create(harness.ctx, form());

    const report = await runConcurrently(6, (index) =>
      templates.remove(ctxFor(index), { id: created.id }),
    );

    expect(report.winners).toBe(1);
    expect(report.rejected.map(codeOf)).toEqual(
      Array.from({ length: 5 }, () => 'SHIPPING_TEMPLATE_NOT_FOUND'),
    );
    // And the survivor is gone for everyone: the detail route refuses it too.
    await expect(templates.detail(harness.ctx, { id: created.id })).rejects.toThrow(DomainError);
  });
});

// ---------------------------------------------------------------------------
// the aggregate write
// ---------------------------------------------------------------------------

describe('two operators saving the same template', () => {
  it('leaves one operator’s rules, never a mixture of both', async () => {
    const created = await templates.create(harness.ctx, form());

    // Each contender submits a template that is recognisable in every child
    // row: the region's price, the free rule's threshold and the no-delivery
    // city all carry its index.
    const report = await runConcurrently(4, (index) =>
      templates.update(ctxFor(index), { id: created.id }, submission(index)),
    );

    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(4);

    const saved = await templates.detail(harness.ctx, { id: created.id });
    // Exactly one fallback survives — the partial unique index would have
    // refused a second one, and a delete-then-insert that interleaved with
    // another transaction's insert would have produced one.
    expect(saved.regions.filter((region) => region.isFallback)).toHaveLength(1);
    expect(saved.regions).toHaveLength(2);
    expect(saved.freeRules).toHaveLength(1);

    const winner = Number(saved.name.replace('模板', ''));
    expect([0, 1, 2, 3]).toContain(winner);
    // Every child row belongs to that same submission.
    expect(saved.regions[1]?.firstPrice).toBe(`${20 + winner}.00`);
    expect(saved.freeRules[0]?.minUnits).toBe(winner + 1);
    expect(saved.noDeliveryCityIds).toEqual([winner % 2 === 0 ? '110000' : '330100']);
  });

  function submission(index: number): ShippingTemplateForm {
    return form({
      name: `模板${index}`,
      hasFreeRules: true,
      hasNoDeliveryRules: true,
      regions: [
        ...form().regions,
        {
          isFallback: false,
          cityIds: ['330000'],
          firstUnit: 1,
          firstPrice: `${20 + index}.00`,
          additionalUnit: 1,
          additionalPrice: '1.00',
        },
      ],
      freeRules: [{ cityIds: [], minUnits: index + 1, minAmount: null }],
      noDeliveryCityIds: [index % 2 === 0 ? '110000' : '330100'],
    });
  }
});

// ---------------------------------------------------------------------------
// the courier code
// ---------------------------------------------------------------------------

describe('creating the same courier code twice at once', () => {
  it('keeps one row and refuses the rest by their code', async () => {
    const report = await runConcurrently(5, (index) =>
      express.adminCreate(ctxFor(index), {
        code: 'SF',
        name: `顺丰${index}`,
        sortOrder: 0,
        isEnabled: true,
      }),
    );

    expect(report.winners).toBe(1);
    expect(report.rejected.map(codeOf)).toEqual(
      Array.from({ length: 4 }, () => 'SHIPPING_EXPRESS_COMPANY_CODE_TAKEN'),
    );
    expect(report.rejected.map((error) => (error as DomainError).details)).toEqual(
      Array.from({ length: 4 }, () => ({ code: 'SF' })),
    );

    const list = await express.adminList(harness.ctx, { page: 1, pageSize: 20 });
    expect(list.total).toBe(1);
  });
});
