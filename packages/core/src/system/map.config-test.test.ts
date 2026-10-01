import { beforeAll, describe, expect, it } from 'vitest';

import { fixedClock } from '../kernel/clock';
import type { ConfigGroupDef } from '../kernel/config-registry';
import { getConfigTest } from '../kernel/config-test';
import type { Ctx } from '../kernel/context';
import { mapConfig } from './map.config';
import { readAmapGeocode, readTencentGeocode, registerMapConfigTest } from './map.config-test';

const clock = fixedClock('2026-09-24T10:00:00Z');
const logger = { warn: () => undefined, error: () => undefined } as unknown as Ctx['logger'];

/** A ctx whose saved settings are `saved`, keyed by group. */
function ctxWith(saved: Record<string, Record<string, unknown>> = {}): Ctx {
  return {
    clock,
    logger,
    config: {
      get: async (def: ConfigGroupDef) => def.schema.parse(saved[def.group] ?? {}),
    },
  } as unknown as Ctx;
}

beforeAll(() => registerMapConfigTest());

describe('map 「测试服务端 Key」', () => {
  it('refuses without a server key', async () => {
    const result = await getConfigTest('map')!.run(
      ctxWith(),
      mapConfig.schema.parse({ provider: 'tencent' }),
      {},
    );
    expect(result.steps).toEqual([
      { name: '检查配置', ok: false, detail: '没有填写「服务端 Key」' },
    ]);
  });

  it("reads Tencent's answers", () => {
    expect(
      readTencentGeocode({ status: 0, result: { location: { lng: 116.4, lat: 39.9 } } }, '北京市'),
    ).toBe('Key 可用；北京市：116.4, 39.9');
    expect(() => readTencentGeocode({ status: 199, message: 'x' }, '北京市')).toThrow(
      'Key 没有开启 WebServiceAPI',
    );
    expect(() => readTencentGeocode({ status: 347 }, '火星')).toThrow('查不到「火星」');
  });

  it("reads Amap's answers", () => {
    expect(
      readAmapGeocode(
        { status: '1', info: 'OK', geocodes: [{ location: '116.4,39.9' }] },
        '北京市',
      ),
    ).toBe('Key 可用；北京市：116.4,39.9');
    expect(() =>
      readAmapGeocode({ status: '0', info: 'USERKEY_PLAT_NOMATCH', infocode: '10009' }, '北京市'),
    ).toThrow('Web 服务');
  });
});
