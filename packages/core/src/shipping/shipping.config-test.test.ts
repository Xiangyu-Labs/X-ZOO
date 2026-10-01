import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fixedClock } from '../kernel/clock';
import type { ConfigGroupDef } from '../kernel/config-registry';
import { getConfigTest } from '../kernel/config-test';
import type { Ctx } from '../kernel/context';
import { logisticsConfig } from '../system';
import { registerShippingConfigTest } from './shipping.config-test';
import { resetTrackingFetch, setTrackingFetch } from './shipping.logistics.port';

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => registerShippingConfigTest());
afterEach(() => resetTrackingFetch());

describe('logistics 「测试查询」', () => {
  const on = () => logisticsConfig.schema.parse({ provider: 'aliyun-market', appCode: 'code' });

  it('says the key is refused on a 401', async () => {
    setTrackingFetch(async () => new Response('', { status: 401 }));
    const result = await getConfigTest('logistics')!.run(ctxWith(), on(), {
      trackingNo: 'YT1234567890',
    });
    expect(result.steps.at(-1)).toMatchObject({
      name: '查询物流轨迹',
      ok: false,
      detail: 'AppCode 无效',
    });
  });

  it('passes with the latest trace, sending the phone tail and letting the vendor guess the carrier', async () => {
    let url = '';
    setTrackingFetch(async (requested) => {
      url = requested;
      return json({
        status: '0',
        msg: 'ok',
        result: {
          deliverystatus: '3',
          list: [
            { time: '2026-09-23 10:00:00', status: '已揽收' },
            { time: '2026-09-24 09:00:00', status: '已签收' },
          ],
        },
      });
    });
    const result = await getConfigTest('logistics')!.run(ctxWith(), on(), {
      trackingNo: 'SF1234567890',
      phone: '13800138000',
    });
    expect(new URL(url).searchParams.get('no')).toBe('SF1234567890:8000');
    expect(new URL(url).searchParams.has('type')).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)!.detail).toBe('密钥可用；已签收，共 2 条轨迹，最新：已签收');
  });

  it('passes the key when the vendor knows nothing of the number', async () => {
    setTrackingFetch(async () => json({ status: '205', msg: '没有信息' }));
    const result = await getConfigTest('logistics')!.run(ctxWith(), on(), {
      trackingNo: 'YT0000000000',
    });
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)!.detail).toBe(
      '密钥可用，但这个单号没有查到轨迹：可能还没揽收，或快递公司填错了',
    );
  });

  it('translates the carrier code the operator types from our list into the vendor’s', async () => {
    let url = '';
    setTrackingFetch(async (requested) => {
      url = requested;
      return json({ status: '205', msg: '没有信息' });
    });
    await getConfigTest('logistics')!.run(ctxWith(), on(), {
      trackingNo: 'YT1234567890',
      companyCode: 'yuantong',
    });
    expect(new URL(url).searchParams.get('type')).toBe('YTO');
  });

  it('says the server cannot reach the vendor in words, not the network error', async () => {
    setTrackingFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await getConfigTest('logistics')!.run(ctxWith(), on(), {
      trackingNo: 'YT1234567890',
    });
    expect(result.steps.at(-1)!.detail).toBe('连不上物流查询接口，请检查服务器网络');
  });

  it('refuses when tracking is switched off', async () => {
    const result = await getConfigTest('logistics')!.run(
      ctxWith(),
      logisticsConfig.schema.parse({}),
      { trackingNo: 'YT1234567890' },
    );
    expect(result.steps[0]!.name).toBe('检查配置');
    expect(result.ok).toBe(false);
  });
});
