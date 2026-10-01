/**
 * The storefront API's backward compatibility: the part of the generated
 * OpenAPI document under `/api/v1/`, compared with a committed baseline.
 *
 * A released mini-program version stays on shoppers' phones for weeks — WeChat
 * updates it when it pleases, and a shopper who never restarts the app keeps
 * the old one. So once a version is out, the server must keep answering the
 * requests that version sends and keep sending the fields that version reads.
 * The baseline is the surface of the last released version; the diff says
 * what an old client would trip over.
 *
 * Two directions, because the two ends read differently:
 *
 *   response  the old client reads it. Breaking: a path or method removed; a
 *             field removed, made optional or made nullable; an enum value or
 *             a union variant removed; a type changed. The production build
 *             does not validate responses (`@shop/api-client/validate` is
 *             dev-only), so widened limits are fine, and a new enum value is
 *             only worth a note.
 *   request   the server validates it. Breaking: a field or parameter made
 *             required (a new required one included); anything narrowed — an
 *             enum value, a type or `null` no longer accepted, a tighter
 *             length, bound, pattern or format; a field or parameter removed
 *             (the old client still sends it and the server now ignores it).
 *
 * Everything added passes. The functions here are pure; the `api-compat`
 * check reads the files and decides whether a breaking change is fatal.
 */

/** A JSON Schema as zod-to-openapi writes it for OpenAPI 3.1. */
export type Schema = { [keyword: string]: unknown };

export interface SurfaceParam {
  name: string;
  in: string;
  required: boolean;
  schema: Schema;
}

/** One storefront operation, reduced to what a client depends on. */
export interface SurfaceOperation {
  /** The contract's route id, for the reader; not compared. */
  id: string;
  params: SurfaceParam[];
  body?: Schema;
  /** The success status (the lowest 2xx the document declares). */
  status: number;
  /** The success body; absent for a 204. */
  response?: Schema;
}

/** `"GET /api/v1/orders/{id}"` → operation, sorted by path, then method. */
export type Surface = Record<string, SurfaceOperation>;

export type Severity = 'breaking' | 'notable';

export interface Change {
  severity: Severity;
  /** The operation, `"GET /api/v1/orders/{id}"`. */
  op: string;
  /** Where in the operation: `response.items[].price`, `query status`, … */
  at: string;
  message: string;
}

export const STOREFRONT_PREFIX = '/api/v1/';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Keywords kept in the baseline: the ones `compareSchemas` reads. The rest is prose. */
const SCALAR_KEYWORDS = [
  'type',
  'enum',
  'const',
  'required',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'multipleOf',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A schema with descriptions, examples, defaults and editor metadata removed. */
export function slimSchema(schema: unknown): Schema {
  if (!isRecord(schema)) return {};
  const out: Schema = {};
  for (const key of SCALAR_KEYWORDS) {
    if (key in schema) out[key] = schema[key];
  }
  if (isRecord(schema['properties'])) {
    out['properties'] = Object.fromEntries(
      Object.entries(schema['properties']).map(([name, sub]) => [name, slimSchema(sub)]),
    );
  }
  if ('items' in schema) out['items'] = slimSchema(schema['items']);
  if ('additionalProperties' in schema) {
    const extra = schema['additionalProperties'];
    out['additionalProperties'] = typeof extra === 'boolean' ? extra : slimSchema(extra);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list)) out[key] = list.map(slimSchema);
  }
  return out;
}

function jsonBody(holder: unknown): Schema | undefined {
  if (!isRecord(holder) || !isRecord(holder['content'])) return undefined;
  const json = holder['content']['application/json'];
  return isRecord(json) && 'schema' in json ? slimSchema(json['schema']) : undefined;
}

/** The storefront part of an OpenAPI document, keyed and reduced for comparison. */
export function storefrontSurface(doc: unknown): Surface {
  const paths = isRecord(doc) && isRecord(doc['paths']) ? doc['paths'] : {};
  const entries: [string, SurfaceOperation][] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith(STOREFRONT_PREFIX) || !isRecord(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const params: SurfaceParam[] = (Array.isArray(op['parameters']) ? op['parameters'] : [])
        .filter(isRecord)
        .map((p) => ({
          name: String(p['name']),
          in: String(p['in']),
          required: p['required'] === true,
          schema: slimSchema(p['schema']),
        }))
        .sort((a, b) =>
          a.in === 'path' && b.in === 'path'
            ? 0 // path parameters keep the path's order
            : `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`),
        );
      const responses = isRecord(op['responses']) ? op['responses'] : {};
      const status = Object.keys(responses)
        .map(Number)
        .filter((code) => code >= 200 && code < 300)
        .sort((a, b) => a - b)[0];
      const body = jsonBody(op['requestBody']);
      const response = status === undefined ? undefined : jsonBody(responses[String(status)]);
      entries.push([
        `${method.toUpperCase()} ${path}`,
        {
          id: String(op['operationId'] ?? ''),
          params,
          ...(body === undefined ? {} : { body }),
          status: status ?? 200,
          ...(response === undefined ? {} : { response }),
        },
      ]);
    }
  }
  entries.sort(([a], [b]) => {
    const [ma = '', pa = ''] = a.split(' ');
    const [mb = '', pb = ''] = b.split(' ');
    return pa === pb ? ma.localeCompare(mb) : pa.localeCompare(pb);
  });
  return Object.fromEntries(entries);
}

/** `GET /api/v1/orders/{id}` and `GET /api/v1/orders/{orderId}` are the same URL to a client. */
function urlShape(key: string): string {
  return key.replace(/\{[^}]+\}/g, '{}');
}

// -- schemas ------------------------------------------------------------------

type Direction = 'request' | 'response';

interface Alternatives {
  nullable: boolean;
  /** Accepts anything (`{}` — `z.unknown()`). */
  any: boolean;
  /** The non-null alternatives, each of one kind. */
  variants: Schema[];
}

const COMPOSITE = ['anyOf', 'oneOf', 'allOf', 'type', 'enum', 'const', 'properties', 'items'];

function alternatives(schema: Schema): Alternatives {
  if (!COMPOSITE.some((k) => k in schema) && !('additionalProperties' in schema)) {
    return { nullable: true, any: true, variants: [] };
  }
  const union = (schema['anyOf'] ?? schema['oneOf']) as Schema[] | undefined;
  if (Array.isArray(union)) {
    const parts = union.map(alternatives);
    return {
      nullable: parts.some((p) => p.nullable),
      any: parts.some((p) => p.any),
      variants: parts.flatMap((p) => p.variants),
    };
  }
  let nullable = false;
  let rest: Schema = schema;
  const type = schema['type'];
  if (Array.isArray(type)) {
    nullable = type.includes('null');
    const types = type.filter((t) => t !== 'null');
    if (types.length !== 1) {
      return {
        nullable,
        any: false,
        variants: types.map((t) => ({ ...schema, type: t })),
      };
    }
    rest = { ...schema, type: types[0] };
  } else if (type === 'null') {
    return { nullable: true, any: false, variants: [] };
  }
  const values = enumOf(rest);
  if (values?.includes(null)) {
    nullable = true;
    const remaining = values.filter((v) => v !== null);
    if (remaining.length === 0) return { nullable, any: false, variants: [] };
    const { const: _const, ...withoutConst } = rest;
    rest = { ...withoutConst, enum: remaining };
  }
  return { nullable, any: false, variants: [rest] };
}

function enumOf(schema: Schema): unknown[] | undefined {
  if (Array.isArray(schema['enum'])) return schema['enum'] as unknown[];
  if ('const' in schema) return [schema['const']];
  return undefined;
}

function kindOf(schema: Schema): string {
  if (Array.isArray(schema['allOf'])) return 'allOf';
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if ('properties' in schema || 'additionalProperties' in schema) return 'object';
  if ('items' in schema) return 'array';
  const values = enumOf(schema);
  if (values && values.length > 0) {
    const first = values[0];
    return typeof first === 'number' ? 'number' : typeof first;
  }
  return 'any';
}

function propertiesOf(schema: Schema): Record<string, Schema> {
  return isRecord(schema['properties']) ? (schema['properties'] as Record<string, Schema>) : {};
}

function singleValue(schema: Schema | undefined): unknown {
  if (!schema) return undefined;
  const values = enumOf(schema);
  return values?.length === 1 ? values[0] : undefined;
}

/**
 * A stable name per variant, so a union's branches are matched by meaning, not
 * position: `object(kind=product)` for a discriminated union, the kind when it
 * is the only one of its kind, the kind and its index otherwise.
 */
function variantKeys(variants: readonly Schema[]): string[] {
  const kinds = variants.map(kindOf);
  const objects = variants.filter((_, i) => kinds[i] === 'object');
  let discriminator: string | undefined;
  if (objects.length > 1) {
    const [first] = objects;
    discriminator = Object.keys(first ? propertiesOf(first) : {}).find((name) => {
      const seen = objects.map((o) => singleValue(propertiesOf(o)[name]));
      return seen.every((v) => v !== undefined) && new Set(seen.map(String)).size === seen.length;
    });
  }
  return variants.map((variant, i) => {
    const kind = kinds[i] ?? 'any';
    if (kind === 'object' && discriminator !== undefined) {
      return `object(${discriminator}=${String(singleValue(propertiesOf(variant)[discriminator]))})`;
    }
    return kinds.filter((k) => k === kind).length > 1 ? `${kind}#${i}` : kind;
  });
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

interface Sink {
  op: string;
  out: Change[];
}

function add(sink: Sink, severity: Severity, at: string, message: string): void {
  sink.out.push({ severity, op: sink.op, at, message });
}

/**
 * Appends every change between `before` and `after`, read in `dir`.
 * `at` is where the schema sits, for the finding.
 */
export function compareSchemas(
  dir: Direction,
  before: Schema,
  after: Schema,
  at: string,
  sink: Sink,
): void {
  const a = alternatives(before);
  const b = alternatives(after);

  if (a.any || b.any) {
    if (dir === 'request' && a.any && !b.any) {
      add(sink, 'breaking', at, 'narrowed from any value to a schema');
    }
    if (dir === 'response' && !a.any && b.any) {
      add(sink, 'notable', at, 'may now be any value');
    }
    return;
  }
  if (dir === 'response' && !a.nullable && b.nullable) {
    add(sink, 'breaking', at, 'made nullable: the released client reads it as always present');
  }
  if (dir === 'request' && a.nullable && !b.nullable) {
    add(sink, 'breaking', at, 'no longer accepts null');
  }

  const keysA = variantKeys(a.variants);
  const keysB = variantKeys(b.variants);
  const union = a.variants.length > 1 || b.variants.length > 1;
  const matchedB = new Set<number>();
  const pairs = new Map<number, number>();

  // By name first; then a leftover variant takes the only leftover of its kind
  // (a lone object that became one branch of a discriminated union). Integers
  // are numbers: a request may widen to `number`, a response may narrow to `integer`.
  keysA.forEach((keyA, i) => {
    const j = keysB.indexOf(keyA);
    if (j >= 0 && !matchedB.has(j)) {
      pairs.set(i, j);
      matchedB.add(j);
    }
  });
  const compatible = (kindA: string, kindB: string) =>
    kindA === kindB ||
    (dir === 'request' && kindA === 'integer' && kindB === 'number') ||
    (dir === 'response' && kindA === 'number' && kindB === 'integer');
  const plain = (key: string) => !key.includes('(') && !key.includes('#');
  a.variants.forEach((variantA, i) => {
    const keyA = keysA[i] ?? '';
    if (pairs.has(i)) return;
    let candidates = b.variants
      .map((variantB, j) => ({ j, kind: kindOf(variantB), key: keysB[j] ?? '' }))
      .filter(
        ({ j, kind, key }) =>
          !matchedB.has(j) && compatible(kindOf(variantA), kind) && (plain(keyA) || plain(key)),
      );
    // A lone object against a tagged branch: its own tag must agree, so the
    // `category` branch is never taken for a removed `product` one.
    candidates = candidates.filter(({ j, key }) => {
      const variantB = b.variants[j] ?? {};
      const tagA = /^object\(([^=]+)=(.*)\)$/.exec(keyA);
      const tagB = /^object\(([^=]+)=(.*)\)$/.exec(key);
      const [plainSide, tag] = tagA
        ? [variantB, tagA]
        : tagB
          ? [variantA, tagB]
          : [undefined, null];
      if (!plainSide || !tag) return true;
      const own = singleValue(propertiesOf(plainSide)[tag[1] ?? '']);
      return own === undefined || String(own) === tag[2];
    });
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only) {
      pairs.set(i, only.j);
      matchedB.add(only.j);
    }
  });

  a.variants.forEach((variantA, i) => {
    const keyA = keysA[i] ?? '';
    const j = pairs.get(i);
    if (j === undefined) {
      add(
        sink,
        'breaking',
        at,
        dir === 'request'
          ? `no longer accepts ${keyA}${union ? '' : ` (now ${keysB.join(' | ') || 'null'})`}`
          : `no longer ${keyA}${union ? ' in any variant' : ` (now ${keysB.join(' | ') || 'null'})`}`,
      );
      return;
    }
    const variantB = b.variants[j] ?? {};
    compareVariant(dir, variantA, variantB, union ? `${at}<${keyA}>` : at, sink);
  });

  if (dir === 'response') {
    keysB.forEach((keyB, j) => {
      if (union && !matchedB.has(j) && a.variants.length > 0) {
        add(sink, 'notable', at, `may now also be ${keyB}; the released client does not know it`);
      }
    });
  }
}

function compareVariant(dir: Direction, a: Schema, b: Schema, at: string, sink: Sink): void {
  const kind = kindOf(a);

  if (kind === 'allOf') {
    const partsA = a['allOf'] as Schema[];
    const partsB = (b['allOf'] ?? []) as Schema[];
    if (partsA.length !== partsB.length) {
      add(sink, 'breaking', at, `intersection of ${partsA.length} parts became ${partsB.length}`);
      return;
    }
    partsA.forEach((part, i) => compareSchemas(dir, part, partsB[i] ?? {}, `${at}&${i}`, sink));
    return;
  }

  compareEnums(dir, a, b, at, sink);
  if (dir === 'request') compareLimits(a, b, at, sink);

  if (kind === 'object') compareObjects(dir, a, b, at, sink);
  if (kind === 'array' && isRecord(a['items'])) {
    compareSchemas(dir, a['items'] as Schema, (b['items'] ?? {}) as Schema, `${at}[]`, sink);
  }
}

function compareEnums(dir: Direction, a: Schema, b: Schema, at: string, sink: Sink): void {
  const valuesA = enumOf(a);
  const valuesB = enumOf(b);
  if (valuesA && valuesB) {
    const inB = new Set(valuesB.map(show));
    const inA = new Set(valuesA.map(show));
    for (const value of valuesA) {
      if (inB.has(show(value))) continue;
      add(
        sink,
        'breaking',
        at,
        dir === 'request'
          ? `no longer accepts ${show(value)}`
          : `enum value ${show(value)} removed: the released client handles it`,
      );
    }
    if (dir === 'response') {
      for (const value of valuesB) {
        if (inA.has(show(value))) continue;
        add(
          sink,
          'notable',
          at,
          `new enum value ${show(value)}; the released client does not know it`,
        );
      }
    }
    return;
  }
  if (valuesA && !valuesB && dir === 'response') {
    add(sink, 'notable', at, `no longer limited to ${valuesA.map(show).join(', ')}`);
  }
  if (!valuesA && valuesB && dir === 'request') {
    add(sink, 'breaking', at, `now limited to ${valuesB.map(show).join(', ')}`);
  }
}

type Bound = { value: number; exclusive: boolean };

function lowerBound(s: Schema): Bound | undefined {
  const min = typeof s['minimum'] === 'number' ? s['minimum'] : undefined;
  const ex = typeof s['exclusiveMinimum'] === 'number' ? s['exclusiveMinimum'] : undefined;
  if (min === undefined && ex === undefined) return undefined;
  if (ex !== undefined && (min === undefined || ex >= min)) return { value: ex, exclusive: true };
  return { value: min as number, exclusive: false };
}

function upperBound(s: Schema): Bound | undefined {
  const max = typeof s['maximum'] === 'number' ? s['maximum'] : undefined;
  const ex = typeof s['exclusiveMaximum'] === 'number' ? s['exclusiveMaximum'] : undefined;
  if (max === undefined && ex === undefined) return undefined;
  if (ex !== undefined && (max === undefined || ex <= max)) return { value: ex, exclusive: true };
  return { value: max as number, exclusive: false };
}

function describeBound(bound: Bound | undefined, lower: boolean): string {
  if (!bound) return 'none';
  return `${lower ? (bound.exclusive ? '>' : '≥') : bound.exclusive ? '<' : '≤'} ${bound.value}`;
}

/** Only a request is validated in production, so only a request can be narrowed. */
function compareLimits(a: Schema, b: Schema, at: string, sink: Sink): void {
  for (const [key, lower] of [
    ['minLength', true],
    ['maxLength', false],
    ['minItems', true],
    ['maxItems', false],
  ] as const) {
    const before = typeof a[key] === 'number' ? (a[key] as number) : undefined;
    const after = typeof b[key] === 'number' ? (b[key] as number) : undefined;
    if (after === undefined) continue;
    const narrower = before === undefined || (lower ? after > before : after < before);
    if (narrower) add(sink, 'breaking', at, `${key} narrowed: ${before ?? 'none'} → ${after}`);
  }

  const lowA = lowerBound(a);
  const lowB = lowerBound(b);
  if (
    lowB &&
    (!lowA ||
      lowB.value > lowA.value ||
      (lowB.value === lowA.value && lowB.exclusive && !lowA.exclusive))
  ) {
    add(
      sink,
      'breaking',
      at,
      `lower bound narrowed: ${describeBound(lowA, true)} → ${describeBound(lowB, true)}`,
    );
  }
  const highA = upperBound(a);
  const highB = upperBound(b);
  if (
    highB &&
    (!highA ||
      highB.value < highA.value ||
      (highB.value === highA.value && highB.exclusive && !highA.exclusive))
  ) {
    add(
      sink,
      'breaking',
      at,
      `upper bound narrowed: ${describeBound(highA, false)} → ${describeBound(highB, false)}`,
    );
  }

  for (const key of ['pattern', 'format'] as const) {
    if (b[key] === undefined || b[key] === a[key]) continue;
    add(
      sink,
      'breaking',
      at,
      a[key] === undefined
        ? `now requires ${key} ${show(b[key])}`
        : `${key} changed: ${show(a[key])} → ${show(b[key])}`,
    );
  }

  const stepA = typeof a['multipleOf'] === 'number' ? a['multipleOf'] : undefined;
  const stepB = typeof b['multipleOf'] === 'number' ? b['multipleOf'] : undefined;
  if (stepB !== undefined && (stepA === undefined || stepA % stepB !== 0)) {
    add(sink, 'breaking', at, `multipleOf narrowed: ${stepA ?? 'none'} → ${stepB}`);
  }
}

function requiredOf(schema: Schema): Set<string> {
  return new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);
}

function compareObjects(dir: Direction, a: Schema, b: Schema, at: string, sink: Sink): void {
  const propsA = propertiesOf(a);
  const propsB = propertiesOf(b);
  const reqA = requiredOf(a);
  const reqB = requiredOf(b);

  for (const [name, schemaA] of Object.entries(propsA)) {
    const where = `${at}.${name}`;
    const schemaB = propsB[name];
    if (!schemaB) {
      add(
        sink,
        'breaking',
        where,
        dir === 'request'
          ? 'removed: the released client still sends it, and the server now ignores or refuses it'
          : 'removed: the released client reads it',
      );
      continue;
    }
    if (dir === 'response' && reqA.has(name) && !reqB.has(name)) {
      add(sink, 'breaking', where, 'made optional: the released client reads it as always present');
    }
    if (dir === 'request' && !reqA.has(name) && reqB.has(name)) {
      add(sink, 'breaking', where, 'made required: the released client may not send it');
    }
    compareSchemas(dir, schemaA, schemaB, where, sink);
  }

  if (dir === 'request') {
    for (const name of Object.keys(propsB)) {
      if (!(name in propsA) && reqB.has(name)) {
        add(
          sink,
          'breaking',
          `${at}.${name}`,
          'new required field: the released client never sends it',
        );
      }
    }
  }

  const mapA = a['additionalProperties'];
  const mapB = b['additionalProperties'];
  if (isRecord(mapA)) {
    if (isRecord(mapB)) compareSchemas(dir, mapA, mapB, `${at}{}`, sink);
    else if (dir === 'request' || Object.keys(propsA).length === 0) {
      add(sink, 'breaking', `${at}{}`, 'no longer a map of arbitrary keys');
    }
  }
}

// -- operations ---------------------------------------------------------------

function compareParams(before: SurfaceOperation, after: SurfaceOperation, sink: Sink): void {
  const pathA = before.params.filter((p) => p.in === 'path');
  const pathB = after.params.filter((p) => p.in === 'path');
  // Same URL shape, so the same number of path parameters, matched by position.
  pathA.forEach((p, i) => {
    const q = pathB[i];
    if (q) compareSchemas('request', p.schema, q.schema, `path {${p.name}}`, sink);
  });

  const named = (p: SurfaceParam) => `${p.in} ${p.name}`;
  const others = (op: SurfaceOperation) =>
    new Map(op.params.filter((p) => p.in !== 'path').map((p) => [named(p), p]));
  const otherA = others(before);
  const otherB = others(after);
  for (const [key, p] of otherA) {
    const q = otherB.get(key);
    if (!q) {
      add(
        sink,
        'breaking',
        key,
        'removed: the released client still sends it, and the server now ignores or refuses it',
      );
      continue;
    }
    if (!p.required && q.required) {
      add(sink, 'breaking', key, 'made required: the released client may not send it');
    }
    compareSchemas('request', p.schema, q.schema, key, sink);
  }
  for (const [key, q] of otherB) {
    if (!otherA.has(key) && q.required) {
      add(sink, 'breaking', key, 'new required parameter: the released client never sends it');
    }
  }
}

function compareOperation(before: SurfaceOperation, after: SurfaceOperation, sink: Sink): void {
  compareParams(before, after, sink);

  if (before.body && !after.body) {
    add(sink, 'breaking', 'body', 'request body removed: the released client still sends it');
  } else if (!before.body && after.body) {
    const required = requiredOf(after.body);
    if (required.size > 0) {
      add(
        sink,
        'breaking',
        'body',
        `new request body with required ${[...required].join(', ')}: the released client sends none`,
      );
    }
  } else if (before.body && after.body) {
    compareSchemas('request', before.body, after.body, 'body', sink);
  }

  if (before.status !== after.status) {
    add(sink, 'notable', 'response', `success status ${before.status} → ${after.status}`);
  }
  if (before.response && !after.response) {
    add(sink, 'breaking', 'response', 'response body removed: the released client reads it');
  } else if (before.response && after.response) {
    compareSchemas('response', before.response, after.response, 'response', sink);
  }
}

/** Every change from `baseline` to `current`, breaking ones first, then in surface order. */
export function diffSurfaces(baseline: Surface, current: Surface): Change[] {
  const byShape = new Map<string, SurfaceOperation>();
  for (const [key, op] of Object.entries(current)) byShape.set(urlShape(key), op);

  const out: Change[] = [];
  for (const [key, before] of Object.entries(baseline)) {
    const after = byShape.get(urlShape(key));
    const sink: Sink = { op: key, out };
    if (!after) {
      add(sink, 'breaking', 'operation', 'path or method removed: the released client calls it');
      continue;
    }
    compareOperation(before, after, sink);
  }
  const rank = (c: Change) => (c.severity === 'breaking' ? 0 : 1);
  return out
    .map((change, index) => ({ change, index }))
    .sort((x, y) => rank(x.change) - rank(y.change) || x.index - y.index)
    .map(({ change }) => change);
}

/** One line per change, as the check and the refresh command print it. */
export function formatChange(change: Change): string {
  return `${change.op} · ${change.at}: ${change.message}`;
}
