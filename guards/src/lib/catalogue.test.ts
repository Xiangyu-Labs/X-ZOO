import { describe, expect, it } from 'vitest';
import { RULE_ID_IN_TEXT, parseCatalogue } from './catalogue';

describe('parseCatalogue', () => {
  const doc = [
    '# Business rules',
    '',
    'Intro prose with `a::b` that is not a citation.',
    '',
    '## Payments',
    '',
    '### PAY-001',
    '',
    'The rule, with `code` in it.',
    '',
    '- `packages/core/src/x.test.ts::describe > it`',
    '- `` e2e/y.spec.ts::names `a thing` ``',
    '- a plain bullet that is text',
    '',
    '### RISK-D-002',
    '',
    'Another rule.',
    '',
    '### Not an id',
    '',
    '## Empty area',
  ].join('\n');

  it('reads each rule with its area, text and citations', () => {
    const { rules } = parseCatalogue(doc);
    expect(rules.map((r) => [r.id, r.line, r.area])).toEqual([
      ['PAY-001', 7, 'Payments'],
      ['RISK-D-002', 15, 'Payments'],
    ]);
    expect(rules[0]?.citations).toEqual([
      'packages/core/src/x.test.ts::describe > it',
      'e2e/y.spec.ts::names `a thing`',
    ]);
    expect(rules[0]?.text).toContain('a plain bullet that is text');
    expect(rules[1]?.citations).toEqual([]);
  });

  it('reports a rule heading that is not a rule ID', () => {
    expect(parseCatalogue(doc).problems).toEqual([
      { line: 19, message: '"Not an id" is not a rule ID' },
    ]);
  });
});

describe('RULE_ID_IN_TEXT', () => {
  it('finds IDs in a title, and not the tail of a longer token', () => {
    const title = 'REFUND-001 — two requests; see RISK-D-002, not X-REFUND-0012 or ISO-8601';
    expect([...title.matchAll(RULE_ID_IN_TEXT)].map((m) => m[0])).toEqual([
      'REFUND-001',
      'RISK-D-002',
    ]);
  });
});
