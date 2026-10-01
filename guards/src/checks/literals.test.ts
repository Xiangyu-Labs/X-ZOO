import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { literals, pageSizeCap, pageSizeLiterals, timeCuts } from './literals';

/** A whole-tree scan: seconds on a CI runner, far past the 5 s unit default. */
const WHOLE_TREE_MS = 60_000;

/** The `literals` readers against small sources, then the check over the tree. */

describe('pageSize literals', () => {
  it('GUARD-002 — reads the cap from the contract schema, not a guess', () => {
    expect(pageSizeCap()).toBe(100);
    expect(pageSizeCap(z.number().int().min(1).max(50))).toBe(50);
  });

  it('GUARD-002 — finds object, JSX and constant forms', () => {
    const source = `
      useRouteQuery(list, { query: { page: 1, pageSize: 200 } });
      <Table pagination={{ pageSize: 20 }} />;
      <CrudTable pageSize={500} />;
      const PICKER_PAGE_SIZE = 1_000;
    `;
    expect(pageSizeLiterals(source).map((l) => l.value)).toEqual([200, 20, 500, 1000]);
  });

  it('ignores prose and variables', () => {
    const source = `
      // a pageSize: 200 in a comment
      const note = "pageSize: 500";
      callRoute(list, { query: { pageSize: size } });
    `;
    expect(pageSizeLiterals(source)).toEqual([]);
  });
});

describe('instants cut as dates', () => {
  const kinds = (source: string, ui = false) => timeCuts(source, ui).map((c) => c.kind);

  it('GUARD-003 — finds a UTC date cut out of toISOString()', () => {
    expect(kinds('const day = new Date().toISOString().slice(0, 10);')).toEqual(['utc-cut']);
    expect(kinds("const day = at.toISOString().split('T')[0];")).toEqual(['utc-cut']);
  });

  it('GUARD-003 — passes a cut from an instant shifted to Shanghai first', () => {
    expect(kinds('return new Date(nowMs + SHOP_OFFSET_MS).toISOString().slice(0, 10);')).toEqual(
      [],
    );
    expect(kinds('return `${shifted.toISOString().slice(0, 19)}+08:00`;')).toEqual([]);
  });

  it('GUARD-003 — finds an instant field sliced as text', () => {
    expect(kinds('<span>{row.createdAt.slice(0, 10)}</span>')).toEqual(['instant-slice']);
    expect(kinds('const t = order.paidAt?.substring(0, 16);')).toEqual(['instant-slice']);
    expect(kinds('const hint = token.slice(0, 10);')).toEqual([]);
  });

  it('GUARD-003 — in UI code, reports every bare toISOString()', () => {
    expect(kinds('<Text>{new Date(x).toISOString()}</Text>', true)).toEqual(['ui-iso']);
    expect(kinds('<Text>{new Date(x).toISOString()}</Text>', false)).toEqual([]);
  });
});

describe('literals over the tree', () => {
  it(
    'GUARD-002 GUARD-003 — the tree sends only accepted page sizes and cuts no UTC dates',
    { timeout: WHOLE_TREE_MS },
    async () => {
      const failures = (await literals.run()).findings.filter((f) => f.level === 'fail');
      expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
    },
  );
});
