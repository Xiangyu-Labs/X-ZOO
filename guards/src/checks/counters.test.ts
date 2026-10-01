import { describe, expect, it } from 'vitest';
import { counters, findCounterWrites } from './counters';

/** A whole-tree scan: seconds on a CI runner, far past the 5 s unit default. */
const WHOLE_TREE_MS = 60_000;

/**
 * The `counters` reader against small sources: each case is one way of
 * writing a counter, and says whether it may be stale.
 */

const texts = (source: string) => findCounterWrites(source).map((w) => w.text);

describe('findCounterWrites', () => {
  it('GUARD-001 — finds a stock written back from a value read earlier', () => {
    const source = `
      const row = await tx.select().from(skus).where(eq(skus.id, id));
      await tx.update(skus).set({ stock: row.stock - quantity, updatedAt: now }).where(eq(skus.id, id));
    `;
    expect(texts(source)).toEqual(['stock: row.stock - quantity']);
  });

  it('GUARD-001 — finds the shorthand and the onConflictDoUpdate form', () => {
    const source = `
      await tx.update(templates).set({ remainingCount }).where(eq(templates.id, id));
      await tx.insert(t).values(v).onConflictDoUpdate({ target: t.id, set: { sales: next } });
    `;
    expect(texts(source)).toEqual(['remainingCount', 'sales: next']);
  });

  it('passes an sql increment, a literal reset and a non-counter column', () => {
    const source = `
      await tx.update(skus).set({ stock: sql\`\${skus.stock} - \${n}\`, sales: sql<number>\`\${skus.sales} + 1\` });
      await tx.update(tokens).set({ views: 0, name: body.name });
    `;
    expect(texts(source)).toEqual([]);
  });

  it('passes a compare-and-set whose where reads the same column', () => {
    const source = `
      return conditionalUpdate(tx, productSkus, {
        where: and(eq(productSkus.id, args.id), eq(productSkus.stock, args.expected)),
        set: { stock: args.next },
      });
    `;
    expect(texts(source)).toEqual([]);
  });

  it('is not fooled by a counter named in a comment or a string', () => {
    const source = `
      // .set({ stock: row.stock })
      const doc = ".set({ stock: row.stock })";
    `;
    expect(texts(source)).toEqual([]);
  });

  it('reports the line of the assignment', () => {
    expect(findCounterWrites('\n\nx.set({\n  quota: form.quota,\n})')[0]?.line).toBe(4);
  });
});

describe('counters over the tree', () => {
  it(
    'GUARD-001 — every counter write in the server is sql, compare-and-set or excused',
    { timeout: WHOLE_TREE_MS },
    async () => {
      const failures = (await counters.run()).findings.filter((f) => f.level === 'fail');
      expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
    },
  );
});
