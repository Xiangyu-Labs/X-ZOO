import { describe, expect, it } from 'vitest';
import { fixtures, scanTestSource } from './fixtures';

describe('scanTestSource', () => {
  it('flags a fetch stubbed through configureApi', () => {
    const source = [
      "import { configureApi } from '@/admin/api/config';",
      'configureApi({',
      '  validateResponses: true,',
      '  async fetch() {',
      '    return new Response(JSON.stringify({ items: [] }), { status: 200 });',
      '  },',
      '});',
    ].join('\n');
    expect(scanTestSource(source)).toEqual({ configuresFetch: [2], rawResponses: [5] });
  });

  it('flags a hand-built Response in a test that uses stubRoutes', () => {
    const source = ['stubRoutes([', "  on(route, () => Response.json({ id: '1' })),", ']);'].join(
      '\n',
    );
    expect(scanTestSource(source)).toEqual({ configuresFetch: [], rawResponses: [2] });
  });

  it('accepts fixtures that go through the contract', () => {
    const source = [
      'configureApi({ validateResponses: true });',
      'stubRoutes([',
      '  on(listRoute, { items: [], total: 0, page: 1, pageSize: 20 }),',
      "  on(saveRoute, () => respondWithError(500, { code: 'INTERNAL', message: '出错了' })),",
      ']);',
      '// new Response( in a comment is prose, not a stub',
    ].join('\n');
    expect(scanTestSource(source)).toEqual({ configuresFetch: [], rawResponses: [] });
  });

  it('leaves a Response alone in a test that never points the admin client anywhere', () => {
    const source = "const res = new Response('ok');\nexpect(await read(res)).toBe('ok');";
    expect(scanTestSource(source)).toEqual({ configuresFetch: [], rawResponses: [] });
  });
});

describe('fixtures over the tree', () => {
  it('finds no component test answering outside the contract', async () => {
    const failures = (await fixtures.run()).findings.filter((f) => f.level === 'fail');
    expect(failures.map((f) => `${f.where}: ${f.message}`).join('\n')).toBe('');
  });
});
