import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aliyunExpressType } from './shipping.aliyun-codes';

describe('aliyunExpressType', () => {
  it.each([
    ['yuantong', 'YTO'],
    ['zhongtong', 'ZTO'],
    ['shunfeng', 'SFEXPRESS'],
    ['yunda', 'YUNDA'],
    ['shentong', 'STO'],
    ['jtexpress', 'JITU'],
    ['youzhengguonei', 'CHINAPOST'],
    ['jd', 'JD'],
    ['ems', 'EMS'],
  ])('translates our %s to the vendor’s %s', (ours, theirs) => {
    expect(aliyunExpressType(ours)).toBe(theirs);
  });

  it('takes the vendor’s own code as it is, in either case', () => {
    expect(aliyunExpressType('YTO')).toBe('YTO');
    expect(aliyunExpressType('sfexpress')).toBe('SFEXPRESS');
    expect(aliyunExpressType(' Yuantong ')).toBe('YTO');
  });

  it('sends no type for a code it does not know, so the vendor guesses from the number', () => {
    expect(aliyunExpressType('')).toBeUndefined();
    // WeChat's code for 顺丰, which the vendor answers with 204.
    expect(aliyunExpressType('SF')).toBeUndefined();
    expect(aliyunExpressType('some-local-courier')).toBeUndefined();
  });

  it('knows every carrier the shop ships with out of the box', () => {
    const seeded = JSON.parse(
      readFileSync(
        new URL('../../../db/seed-data/express-companies.json', import.meta.url),
        'utf8',
      ),
    ) as { code: string; name: string; isEnabled: boolean }[];
    const unknown = seeded
      .filter((company) => company.isEnabled && aliyunExpressType(company.code) === undefined)
      .map((company) => `${company.code} ${company.name}`);
    expect(unknown).toEqual([]);
  });
});
