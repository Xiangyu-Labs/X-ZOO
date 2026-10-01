/**
 * MUT-001 — the ten protections, each with the one textual change that removes
 * it and the tests that are supposed to notice.
 *
 * Every mutation is a literal `search → replace` on one file. The runner
 * asserts the search text occurs **exactly once** in the copy it mutates, so a
 * protection that moved or was reworded fails the run loudly ("does not match")
 * instead of silently mutating nothing and reporting a kill that never
 * happened. When that happens, re-read the protection and update the strings
 * here; do not loosen the check.
 *
 * `tests` name the guarding tests the way `docs/invariants.md` does: a file under
 * `packages/core`, the top-level `describe` title, and optionally a pattern
 * over the `it` title. The runner narrows each vitest run with `-t` on the
 * `describe` titles and then reads the JSON report, so the selection is exact
 * whatever separator vitest puts between a `describe` and its tests. A mutant
 * is killed when at least one selected test fails. The same selection is the
 * baseline, which must run at least one test per entry and pass every one.
 *
 * The ten are the ones MUT-001 lists (`docs/invariants.md`), in its order.
 */

export type TestProject = 'unit' | 'int';

export interface GuardingTest {
  /** Relative to `packages/core`. */
  file: string;
  /** The top-level `describe` title, exactly. */
  describe: string;
  /** A regular expression over the `it` title; omitted, every test in the `describe`. */
  it?: string;
  project: TestProject;
}

export interface Mutation {
  id: string;
  /** The protection, as MUT-001 names it. */
  protection: string;
  /** Relative to the repository root. */
  file: string;
  /** What removing the protection looks like, in one line for the table. */
  summary: string;
  search: string;
  replace: string;
  tests: readonly GuardingTest[];
}

const PAYMENT_INT = 'src/payment/payment.int.test.ts';
const PAYMENT_CONCURRENCY = 'src/payment/payment.concurrency.int.test.ts';

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'order-lock',
    protection: 'the payment/cancel order lock',
    file: 'packages/core/src/payment/payment.repo.ts',
    summary: '`lockOrderForPayment` reads the order without `FOR UPDATE`',
    search: [
      '    .where(eq(orders.id, orderId))',
      '    .limit(1)',
      "    .for('update');",
      '  return (rows[0] as OrderPaymentRow | undefined) ?? null;',
    ].join('\n'),
    replace: [
      '    .where(eq(orders.id, orderId))',
      '    .limit(1);',
      '  return (rows[0] as OrderPaymentRow | undefined) ?? null;',
    ].join('\n'),
    tests: [
      {
        file: 'src/payment/payment.cancel-lock.int.test.ts',
        describe: 'PAYC-001 — a payment started while a cancel holds the order lock',
        project: 'int',
      },
      {
        file: PAYMENT_INT,
        describe: 'PAYC-001 — a create in flight is never stepped over',
        project: 'int',
      },
      {
        file: PAYMENT_CONCURRENCY,
        describe: 'QUEUE-003 — a callback racing an order cancel',
        project: 'int',
      },
    ],
  },
  {
    id: 'attempt-immutable',
    protection: 'attempt immutability',
    file: 'packages/core/src/payment/payment.service.ts',
    summary: '`reuse` hands back the stored attempt even when the replay disagrees',
    search: ['  if (!same) {', "    throw new DomainError('PAYMENT_ATTEMPT_CONFLICT', {"].join(
      '\n',
    ),
    replace: [
      '  if (!same && same) {',
      "    throw new DomainError('PAYMENT_ATTEMPT_CONFLICT', {",
    ].join('\n'),
    tests: [
      { file: PAYMENT_INT, describe: 'PAYC-004 — the attempt is immutable', project: 'int' },
      {
        file: PAYMENT_CONCURRENCY,
        describe: 'PAYC-004 — starting the same payment twice',
        it: '^refuses a replay that disagrees',
        project: 'int',
      },
    ],
  },
  {
    id: 'gateway-confirmed-close',
    protection: 'the gateway-confirmed close',
    file: 'packages/core/src/payment/payment.service.ts',
    summary: 'a close the gateway did not answer is recorded as `closed` and reported closed',
    search: [
      '    await ctx.withTx((tx) =>',
      '      repo.markAttemptUnknown(tx, attempt.id, `close unknown: ${messageOf(error)}`),',
      '    );',
      "    return 'unknown';",
    ].join('\n'),
    replace: [
      '    await ctx.withTx((tx) =>',
      '      repo.markAttemptClosed(tx, attempt.id, {',
      '        confirmedAt: ctx.clock.now(),',
      '        lastResult: `closed: assumed after ${messageOf(error)}`,',
      '      }),',
      '    );',
      "    return 'closed';",
    ].join('\n'),
    tests: [
      {
        file: PAYMENT_CONCURRENCY,
        describe: 'QUEUE-003 — a callback racing an order cancel',
        it: '^refuses to cancel while an attempt is merely unknown',
        project: 'int',
      },
      {
        file: PAYMENT_CONCURRENCY,
        describe: 'TLS-006 — an unverifiable gateway answer never becomes closed or paid',
        it: '^(refuses to cancel an order whose close|treats a dropped connection)',
        project: 'int',
      },
      {
        file: PAYMENT_INT,
        describe: 'PAYC-001 — a create in flight is never stepped over',
        it: '^releases nothing while the gateway will not say',
        project: 'int',
      },
    ],
  },
  {
    id: 'refund-amount-freeze',
    protection: 'the refund amount freeze',
    file: 'packages/core/src/refund/refund.service.ts',
    summary:
      '`executeRefund` re-derives the request context on every send instead of reusing the frozen one',
    search: '    const context = row.requestContext ?? (await freezeContext(tx, row));',
    replace: '    const context = await freezeContext(tx, row);',
    tests: [
      {
        file: 'src/refund/refund.int.test.ts',
        describe: 'REFUND-005 — a retry may not change what was sent',
        project: 'int',
      },
    ],
  },
  {
    id: 'coupon-remaining-guard',
    protection: 'the coupon remaining-count guard',
    file: 'packages/core/src/coupon/coupon.repo.ts',
    summary: '`takeOneFromSupply` drops `remaining_count > 0` from its WHERE',
    search: [
      '      eq(couponTemplates.isUnlimitedSupply, false),',
      '      gt(couponTemplates.remainingCount, 0),',
      '      liveTemplate(),',
      '    ),',
      '    set: {',
      '      remainingCount: sql`${couponTemplates.remainingCount} - 1`,',
    ].join('\n'),
    replace: [
      '      eq(couponTemplates.isUnlimitedSupply, false),',
      '      liveTemplate(),',
      '    ),',
      '    set: {',
      '      remainingCount: sql`${couponTemplates.remainingCount} - 1`,',
    ].join('\n'),
    tests: [
      {
        file: 'src/coupon/coupon.concurrency.int.test.ts',
        describe: 'COUPON-007 — the last coupon, claimed by two people at once',
        project: 'int',
      },
    ],
  },
  {
    id: 'virtual-card-claim',
    protection: 'the virtual-card atomic claim',
    // The claim `autoDeliver` calls on `order.paid`, and the only one there is.
    file: 'packages/core/src/order/order.fulfil.repo.ts',
    summary: 'the card subquery loses `FOR UPDATE SKIP LOCKED`',
    search: '         order by id limit 1 for update skip locked)`,',
    replace: '         order by id limit 1)`,',
    tests: [
      {
        file: 'src/order/order.fulfil.concurrency.int.test.ts',
        describe: 'two dispatchers replaying the same virtual delivery',
        it: '^gives the last card to exactly one of two orders racing for it',
        project: 'int',
      },
    ],
  },
  {
    id: 'refund-completion-service-amount',
    protection: 'the service-generated refund completion',
    file: 'packages/core/src/refund/refund.service.ts',
    summary:
      "settlement books the payment's total onto the order instead of the amount the service computed for this refund",
    search: '  const raised = await repo.addOrderRefundedAmount(tx, row.orderId, row.amount);',
    replace:
      '  const raised = await repo.addOrderRefundedAmount(tx, row.orderId, row.requestContext?.totalAmount ?? row.amount);',
    tests: [
      {
        file: 'src/refund/refund.int.test.ts',
        describe: 'a refund that goes the way it should',
        it: '^computes the money from the lines',
        project: 'int',
      },
    ],
  },
  {
    id: 'tls-peer-verification',
    protection: 'TLS peer verification',
    file: 'packages/core/src/wechat/wechat.pay.ts',
    summary: 'the pay client turns certificate verification off before it calls the gateway',
    search: '      response = await fetch(new URL(args.urlPath, config.apiBaseUrl), {',
    replace: [
      "      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
      '      response = await fetch(new URL(args.urlPath, config.apiBaseUrl), {',
    ].join('\n'),
    tests: [
      {
        file: 'src/wechat/wechat.pay.tls.test.ts',
        describe: 'TLS-001 — the pay client refuses a gateway it cannot authenticate',
        project: 'unit',
      },
      {
        file: 'src/payment/payment.config.test.ts',
        describe: 'TLS-001 — no TLS toggle in any payment config group',
        project: 'unit',
      },
    ],
  },
  {
    id: 'response-signature',
    protection: 'response signature validation',
    file: 'packages/core/src/wechat/wechat.pay.ts',
    summary: 'the pay client ignores a response whose signature did not verify',
    search: ['    if (!verdict.ok) {', '      ctx.logger.error('].join('\n'),
    replace: ['    if (!verdict.ok && verdict.ok) {', '      ctx.logger.error('].join('\n'),
    tests: [
      {
        file: PAYMENT_CONCURRENCY,
        describe: 'TLS-006 — an unverifiable gateway answer never becomes closed or paid',
        project: 'int',
      },
    ],
  },
  {
    id: 'cancelled-order-payment-branch',
    protection: 'the cancelled-order payment branch',
    file: 'packages/core/src/payment/payment.service.ts',
    summary: 'money arriving for a cancelled order falls through to the paid transition',
    search: ["  if (order.status === 'cancelled') {", '    return exception(tx, ctx, {'].join('\n'),
    replace: [
      "  if (order.status === 'cancelled' && order.status !== 'cancelled') {",
      '    return exception(tx, ctx, {',
    ].join('\n'),
    tests: [
      {
        file: PAYMENT_CONCURRENCY,
        describe: 'PAY-011 — a late callback after the payment was closed',
        project: 'int',
      },
    ],
  },
];
