import { describe, expect, it } from 'vitest';
import {
  diffSurfaces,
  formatChange,
  storefrontSurface,
  type Schema,
  type Surface,
  type SurfaceOperation,
  type SurfaceParam,
} from './api-compat';

/**
 * The `api-compat` diff. Each case changes one thing between a baseline and
 * today's surface and expects exactly that complaint (or none), so a rule that
 * stops firing shows up as a missing line.
 */

const str: Schema = { type: 'string' };
const int: Schema = { type: 'integer' };
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
});

function op(partial: Partial<SurfaceOperation> = {}): SurfaceOperation {
  return { id: 'x.y', params: [], status: 200, ...partial };
}

const query = (name: string, schema: Schema, required = false): SurfaceParam => ({
  name,
  in: 'query',
  required,
  schema,
});

/** The changes as `severity at: message`, operation left out (every case has one). */
function diff(before: SurfaceOperation, after: SurfaceOperation): string[] {
  const key = 'GET /api/v1/things';
  return diffSurfaces({ [key]: before }, { [key]: after }).map(
    (c) => `${c.severity} ${c.at}: ${c.message}`,
  );
}

const breaking = (lines: string[]) => lines.filter((l) => l.startsWith('breaking'));

describe('api-compat: operations', () => {
  it('passes an unchanged surface', () => {
    const same = op({ response: obj({ id: str }, ['id']), body: obj({ q: str }) });
    expect(diff(same, structuredClone(same))).toEqual([]);
  });

  it('fails a removed path, and a removed method on a path that stays', () => {
    const baseline: Surface = {
      'GET /api/v1/a': op(),
      'GET /api/v1/b': op(),
      'POST /api/v1/b': op(),
    };
    const current: Surface = { 'GET /api/v1/b': op() };
    expect(diffSurfaces(baseline, current).map(formatChange)).toEqual([
      'GET /api/v1/a · operation: path or method removed: the released client calls it',
      'POST /api/v1/b · operation: path or method removed: the released client calls it',
    ]);
  });

  it('passes a new path and a renamed path parameter (the URL is the same)', () => {
    const baseline: Surface = {
      'GET /api/v1/orders/{id}': op({
        params: [{ name: 'id', in: 'path', required: true, schema: str }],
      }),
    };
    const current: Surface = {
      'GET /api/v1/orders/{orderId}': op({
        params: [{ name: 'orderId', in: 'path', required: true, schema: str }],
      }),
      'GET /api/v1/orders/{id}/items': op(),
    };
    expect(diffSurfaces(baseline, current)).toEqual([]);
  });

  it('fails a response body that disappears (200 → 204), and notes the status change', () => {
    expect(diff(op({ response: obj({ ok: str }) }), op({ status: 204 }))).toEqual([
      'breaking response: response body removed: the released client reads it',
      'notable response: success status 200 → 204',
    ]);
  });
});

describe('api-compat: responses (the released client reads them)', () => {
  const before = op({ response: obj({ id: str, name: str, note: str }, ['id', 'name']) });

  it('fails a removed field', () => {
    const after = op({ response: obj({ id: str, note: str }, ['id']) });
    expect(diff(before, after)).toEqual([
      'breaking response.name: removed: the released client reads it',
    ]);
  });

  it('fails a field made optional', () => {
    const after = op({ response: obj({ id: str, name: str, note: str }, ['id']) });
    expect(diff(before, after)).toEqual([
      'breaking response.name: made optional: the released client reads it as always present',
    ]);
  });

  it('fails a field made nullable, in either spelling', () => {
    const typeArray = op({
      response: obj({ id: str, name: { type: ['string', 'null'] }, note: str }, ['id', 'name']),
    });
    const anyOf = op({
      response: obj({ id: str, name: { anyOf: [str, { type: 'null' }] }, note: str }, [
        'id',
        'name',
      ]),
    });
    const expected = [
      'breaking response.name: made nullable: the released client reads it as always present',
    ];
    expect(diff(before, typeArray)).toEqual(expected);
    expect(diff(before, anyOf)).toEqual(expected);
  });

  it('fails a changed type, deep in an array', () => {
    const a = op({
      response: obj({ items: { type: 'array', items: obj({ price: str }, ['price']) } }),
    });
    const b = op({
      response: obj({ items: { type: 'array', items: obj({ price: int }, ['price']) } }),
    });
    expect(diff(a, b)).toEqual(['breaking response.items[].price: no longer string (now integer)']);
  });

  it('fails a removed enum value and only notes an added one', () => {
    const a = op({ response: obj({ status: { type: 'string', enum: ['paid', 'shipped'] } }) });
    const b = op({ response: obj({ status: { type: 'string', enum: ['shipped', 'refunded'] } }) });
    expect(diff(a, b)).toEqual([
      'breaking response.status: enum value "paid" removed: the released client handles it',
      'notable response.status: new enum value "refunded"; the released client does not know it',
    ]);
  });

  it('passes additions, a field made required or non-null, and widened limits', () => {
    const a = op({
      response: obj({ id: { type: ['string', 'null'], maxLength: 10 }, tag: str }, []),
    });
    const b = op({
      response: obj({ id: { type: 'string', maxLength: 99 }, tag: str, extra: int }, ['id', 'tag']),
    });
    expect(diff(a, b)).toEqual([]);
  });

  it('matches a discriminated union by its tag, not its position', () => {
    const product = obj({ kind: { type: 'string', enum: ['product'] }, id: str }, ['kind', 'id']);
    const category = obj({ kind: { type: 'string', enum: ['category'] }, id: str }, ['kind', 'id']);
    const url = obj({ kind: { type: 'string', enum: ['url'] }, url: str }, ['kind', 'url']);
    const productWithoutId = obj({ kind: { type: 'string', enum: ['product'] } }, ['kind']);

    const a = op({ response: obj({ link: { oneOf: [product, category] } }) });
    expect(diff(a, op({ response: obj({ link: { oneOf: [url, category, product] } }) }))).toEqual([
      'notable response.link: may now also be object(kind=url); the released client does not know it',
    ]);
    expect(breaking(diff(a, op({ response: obj({ link: { oneOf: [category] } }) })))).toEqual([
      'breaking response.link: no longer object(kind=product) in any variant',
    ]);
    expect(
      diff(a, op({ response: obj({ link: { oneOf: [productWithoutId, category] } }) })),
    ).toEqual([
      'breaking response.link<object(kind=product)>.id: removed: the released client reads it',
    ]);
  });

  it('follows a lone object into the union it became a branch of', () => {
    const product = obj({ kind: { type: 'string', enum: ['product'] }, id: str }, ['kind', 'id']);
    const category = obj({ kind: { type: 'string', enum: ['category'] }, id: str }, ['kind', 'id']);
    const a = op({ response: obj({ link: product }) });
    const b = op({ response: obj({ link: { oneOf: [category, product] } }) });
    expect(diff(a, b)).toEqual([
      'notable response.link: may now also be object(kind=category); the released client does not know it',
    ]);
  });
});

describe('api-compat: requests (the server validates them)', () => {
  it('fails a field made required and a new required field; passes a new optional one', () => {
    const a = op({ body: obj({ phone: str, code: str }, ['phone']) });
    const b = op({
      body: obj({ phone: str, code: str, captcha: str, bindToken: str }, [
        'phone',
        'code',
        'captcha',
      ]),
    });
    expect(diff(a, b)).toEqual([
      'breaking body.code: made required: the released client may not send it',
      'breaking body.captcha: new required field: the released client never sends it',
    ]);
  });

  it('passes an optional field added to a body (the H6 `bindToken` shape)', () => {
    const a = op({ body: obj({ phone: str, password: str }, ['phone', 'password']) });
    const b = op({
      body: obj({ phone: str, password: str, bindToken: str }, ['phone', 'password']),
    });
    expect(diff(a, b)).toEqual([]);
  });

  it('fails a removed field: the released client still sends it', () => {
    const a = op({ body: obj({ phone: str, remark: str }, ['phone']) });
    const b = op({ body: obj({ phone: str }, ['phone']) });
    expect(diff(a, b)).toEqual([
      'breaking body.remark: removed: the released client still sends it, and the server now ignores or refuses it',
    ]);
  });

  it('fails every narrowing', () => {
    const a = op({
      body: obj({
        kind: { type: 'string', enum: ['a', 'b'] },
        name: { type: 'string', minLength: 1, maxLength: 64 },
        qty: { type: 'integer', minimum: 1, maximum: 99 },
        price: { type: 'integer', minimum: 0 },
        note: { type: ['string', 'null'] },
        code: str,
        tags: { type: 'array', items: str, maxItems: 10 },
        id: { anyOf: [{ type: 'string', pattern: '^\\d+$' }, int] },
        any: {},
      }),
    });
    const b = op({
      body: obj({
        kind: { type: 'string', enum: ['a'] },
        name: { type: 'string', minLength: 2, maxLength: 32 },
        qty: { type: 'integer', minimum: 1, maximum: 50 },
        price: { type: 'integer', exclusiveMinimum: 0 },
        note: str,
        code: { type: 'string', pattern: '^\\d{6}$' },
        tags: { type: 'array', items: str, maxItems: 5 },
        id: { type: 'string', pattern: '^\\d+$' },
        any: str,
      }),
    });
    expect(diff(a, b)).toEqual([
      'breaking body.kind: no longer accepts "b"',
      'breaking body.name: minLength narrowed: 1 → 2',
      'breaking body.name: maxLength narrowed: 64 → 32',
      'breaking body.qty: upper bound narrowed: ≤ 99 → ≤ 50',
      'breaking body.price: lower bound narrowed: ≥ 0 → > 0',
      'breaking body.note: no longer accepts null',
      'breaking body.code: now requires pattern "^\\\\d{6}$"',
      'breaking body.tags: maxItems narrowed: 10 → 5',
      'breaking body.id: no longer accepts integer',
      'breaking body.any: narrowed from any value to a schema',
    ]);
  });

  it('passes every widening, integer → number included', () => {
    const a = op({
      body: obj({
        kind: { type: 'string', enum: ['a'] },
        name: { type: 'string', minLength: 2, maxLength: 32, pattern: '^x' },
        qty: { type: 'integer', exclusiveMinimum: 0 },
        note: str,
        id: str,
      }),
    });
    const b = op({
      body: obj({
        kind: { type: 'string', enum: ['a', 'b'] },
        name: { type: 'string', maxLength: 64 },
        qty: { type: 'number', minimum: 0 },
        note: { type: ['string', 'null'] },
        id: { anyOf: [str, int] },
      }),
    });
    expect(diff(a, b)).toEqual([]);
  });

  it('checks query parameters the same way', () => {
    const a = op({ params: [query('page', int), query('status', str), query('old', str)] });
    const b = op({
      params: [
        query('page', int, true),
        query('status', { type: 'string', enum: ['open'] }),
        query('cursor', str, true),
        query('sort', str),
      ],
    });
    expect(diff(a, b)).toEqual([
      'breaking query page: made required: the released client may not send it',
      'breaking query status: now limited to "open"',
      'breaking query old: removed: the released client still sends it, and the server now ignores or refuses it',
      'breaking query cursor: new required parameter: the released client never sends it',
    ]);
  });

  it('fails a body that appears with required fields, or disappears', () => {
    expect(diff(op(), op({ body: obj({ a: str }, ['a']) }))).toEqual([
      'breaking body: new request body with required a: the released client sends none',
    ]);
    expect(diff(op(), op({ body: obj({ a: str }) }))).toEqual([]);
    expect(diff(op({ body: obj({ a: str }) }), op())).toEqual([
      'breaking body: request body removed: the released client still sends it',
    ]);
  });
});

describe('api-compat: reading the OpenAPI document', () => {
  const doc = {
    paths: {
      '/admin-api/things': { get: { operationId: 'admin.things', responses: {} } },
      '/api/v1/things/{id}': {
        get: {
          operationId: 'things.get',
          description: 'prose',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', description: 'x' },
            },
            { name: 'z', in: 'query', required: false, schema: str },
            { name: 'a', in: 'query', required: false, schema: str },
          ],
          responses: {
            '201': { content: { 'application/json': { schema: obj({ id: str }, ['id']) } } },
            '200': {
              content: {
                'application/json': {
                  schema: { ...obj({ id: str }), default: {}, label: '链接', example: 1 },
                },
              },
            },
            '422': { content: { 'application/json': { schema: obj({ code: str }) } } },
          },
        },
        delete: { operationId: 'things.delete', responses: { '204': { description: '无内容' } } },
      },
    },
  };

  it('keeps only /api/v1, the lowest 2xx, and the keywords the diff reads', () => {
    expect(storefrontSurface(doc)).toEqual({
      'DELETE /api/v1/things/{id}': { id: 'things.delete', params: [], status: 204 },
      'GET /api/v1/things/{id}': {
        id: 'things.get',
        params: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'a', in: 'query', required: false, schema: str },
          { name: 'z', in: 'query', required: false, schema: str },
        ],
        status: 200,
        response: obj({ id: str }),
      },
    });
  });
});
