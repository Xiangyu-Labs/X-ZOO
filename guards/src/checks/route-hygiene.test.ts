import { describe, expect, it } from 'vitest';
import { methodsMissingAudit, routeHygiene } from './route-hygiene';
import type { Finding } from '../framework';

/**
 * `force-dynamic` on every route file, and an audit target on every admin
 * write — checked on the handler that writes, not on the file around it.
 *
 * The per-method half is what this file adds: `PUT` and `DELETE` in one file
 * are two decisions, and one of them calling `ctx.audit` must not hide the
 * other not calling it.
 */

const failures: Finding[] = (await routeHygiene.run()).findings.filter((f) => f.level === 'fail');

describe('route hygiene', () => {
  it('finds no failure in the tree', () => {
    expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
  });

  it('judges the audit call per exported method, not per file', () => {
    const source = [
      'export const PUT = handle(userLabelUpdate, async (ctx, { params }) => {',
      '  ctx.audit(`user-label:${params.id}`);',
      '  return update(ctx, params);',
      '});',
      'export const DELETE = handle(userLabelDelete, async (ctx, { params }) => {',
      '  return remove(ctx, params);',
      '});',
    ].join('\n');

    expect(methodsMissingAudit(source, ['PUT', 'DELETE'])).toEqual(['DELETE']);
  });

  it('does not let a commented-out audit cover a handler', () => {
    const source = [
      'export const POST = handle(couponAdminCreate, async (ctx, { body }) => {',
      '  // ctx.audit(`coupon:${created.id}`) was removed',
      '  return create(ctx, body);',
      '});',
    ].join('\n');

    expect(methodsMissingAudit(source, ['POST'])).toEqual(['POST']);
  });
});
