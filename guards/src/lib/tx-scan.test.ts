import { describe, expect, it } from 'vitest';
import { findPoolReaches, findTxFunctions, maskSource } from './tx-scan';

/**
 * The `tx-pool` check's scanner. What it must see, what it must not
 * invent, and the one real shape it exists for.
 */

const reaches = (source: string) =>
  findPoolReaches(source).map((r) => `${r.within}: ${r.construct}`);

describe('the tx-pool scanner', () => {
  it('finds the deadlock shape: a config read inside a function that takes a Tx', () => {
    const source = `
async function warnOnLowStock(tx: Tx, ctx: Ctx, lines: readonly StockLine[]): Promise<void> {
  const { stockWarningThreshold: threshold } = await ctx.config.get(catalogConfig);
  if (threshold <= 0) return;
}`;
    expect(reaches(source)).toEqual(['warnOnLowStock: ctx.config.get(']);
  });

  it('finds ctx.db and a nested ctx.withTx inside a withTx callback', () => {
    const source = `
export async function pay(ctx: Ctx) {
  const before = await repo.find(ctx.db, 1);
  return ctx.withTx(async (tx) => {
    await repo.lock(tx, 1);
    const other = await repo.find(ctx.db, 2);
    await ctx.withTx((inner) => repo.touch(inner));
  });
}`;
    expect(reaches(source)).toEqual(['withTx(callback): ctx.db', 'withTx(callback): ctx.withTx(']);
  });

  it('treats a DbOrTx helper and a bare tx arrow as holding a transaction', () => {
    const source = `
async function buildDraft(ctx: Ctx, db: DbOrTx, userId: number): Promise<Draft> {
  const { payWindowMinutes } = await ctx.config.get(orderConfig);
}
const run = (ctx: Ctx) => ctx.withTx(tx => ctx.config.getRaw('x'));`;
    expect(reaches(source)).toEqual([
      'buildDraft: ctx.config.get(',
      'withTx(callback): ctx.config.getRaw(',
    ]);
  });

  it('allows the read-through spelling and the tx ?? ctx.db fallback', () => {
    const source = `
async function a(tx: Tx, ctx: Ctx) {
  const c = await ctx.config.getIn(tx, catalogConfig);
  const db = tx ?? ctx.db;
  await ctx.redis.get('k');
}`;
    expect(reaches(source)).toEqual([]);
  });

  it('ignores comments, strings, templates and regexes, and code outside a tx function', () => {
    const source = `
async function outside(ctx: Ctx) { await ctx.config.get(g); await ctx.db.select(); }
async function inside(tx: Tx, ctx: Ctx) {
  // ctx.db in a comment
  /* ctx.config.get( in a block */
  const s = 'ctx.db { unbalanced';
  const t = \`ctx.db \${tx.id} } still text\`;
  const r = /ctx\\.db[{(]/;
  return s + t;
}
if (tx) { ctx.db; }`;
    expect(reaches(source)).toEqual([]);
    expect(findTxFunctions(maskSource(source)).map((f) => f.name)).toEqual(['inside']);
  });

  it('keeps offsets: the mask is the same length and keeps every newline', () => {
    const source = "const a = 'x\\ny';\n// c\nconst b = `q${1}`;\n";
    const masked = maskSource(source);
    expect(masked.length).toBe(source.length);
    expect(masked.split('\n').length).toBe(source.split('\n').length);
  });

  it('reads past a return type that carries braces and generics', () => {
    const source = `
async function reserve(tx: Tx, n: number): Promise<{ won: boolean }[]> {
  return ctx.db;
}`;
    expect(reaches(source)).toEqual(['reserve: ctx.db']);
  });
});
