import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigGroupDef } from '../kernel/config-registry';
import type { Ctx } from '../kernel/context';
import {
  logisticsPort,
  parseAliyun,
  resetTrackingFetch,
  setTrackingFetch,
} from './shipping.logistics.port';

/**
 * The vendor's body, parsed. No network: the client is exercised against a fake
 * `fetch` in the integration test, and the mapping is pure and belongs here.
 */

const body = (result: unknown, status = '0') => ({ status, msg: 'ok', result });

describe('parseAliyun', () => {
  it('maps the delivery status and puts the newest trace first', () => {
    const parsed = parseAliyun(
      body({
        deliverystatus: '2',
        issign: '0',
        list: [
          { time: '2026-06-01 09:00:00', status: '快件已到达杭州' },
          { time: '2026-06-02 08:00:00', status: '快递员正在派件' },
        ],
      }),
    );
    expect(parsed.state).toBe('delivering');
    expect(parsed.traces.map((trace) => trace.context)).toEqual([
      '快递员正在派件',
      '快件已到达杭州',
    ]);
    expect(parsed.traces[0]?.at).toBeInstanceOf(Date);
  });

  it.each([
    ['0', 'in_transit'],
    ['1', 'in_transit'],
    ['2', 'delivering'],
    ['3', 'delivered'],
    ['4', 'exception'],
    ['5', 'exception'],
    ['6', 'exception'],
    ['', 'unknown'],
    ['99', 'unknown'],
  ])('maps deliverystatus %s to %s', (code, expected) => {
    expect(parseAliyun(body({ deliverystatus: code, list: [] })).state).toBe(expected);
  });

  it('answers unknown for an error body, which the vendor sends with a 200', () => {
    expect(parseAliyun(body(null, '201'))).toEqual({ state: 'unknown', traces: [] });
    expect(parseAliyun({ nonsense: true })).toEqual({ state: 'unknown', traces: [] });
    expect(parseAliyun(null)).toEqual({ state: 'unknown', traces: [] });
  });

  it('reads the vendor’s times as Shanghai wall time, whatever zone the process runs in', () => {
    const parsed = parseAliyun(
      body({ deliverystatus: '1', list: [{ time: '2026-09-24 10:00:00', status: '已揽收' }] }),
    );
    expect(parsed.traces[0]?.at.toISOString()).toBe('2026-09-24T02:00:00.000Z');
  });

  it('drops a trace whose timestamp cannot be read rather than emitting an Invalid Date', () => {
    const parsed = parseAliyun(
      body({
        deliverystatus: '3',
        list: [
          { time: 'not a date', status: '?' },
          { time: '2026-06-02 08:00:00', status: '已签收' },
        ],
      }),
    );
    expect(parsed.traces).toHaveLength(1);
    expect(parsed.traces[0]?.context).toBe('已签收');
  });
});

describe('logisticsPort.track', () => {
  afterEach(() => resetTrackingFetch());

  const warnings: { fields: Record<string, unknown>; message: string }[] = [];

  /** Tracking on, nothing cached, and every warning kept. */
  function ctx(): Ctx {
    warnings.length = 0;
    return {
      logger: {
        warn: (fields: Record<string, unknown>, message: string) => {
          warnings.push({ fields, message });
        },
      },
      redis: { get: async () => null, set: async () => 'OK' },
      config: {
        get: async (def: ConfigGroupDef) =>
          def.schema.parse({ provider: 'aliyun-market', appCode: 'code' }),
      },
    } as unknown as Ctx;
  }

  function capture(answer: unknown = body({ deliverystatus: '1', list: [] })) {
    const urls: URL[] = [];
    setTrackingFetch(async (url) => {
      urls.push(new URL(url));
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return urls;
  }

  it('sends the vendor’s carrier code, not ours, and no phone for a carrier that needs none', async () => {
    const urls = capture();
    await logisticsPort.track(ctx(), {
      companyCode: 'yuantong',
      trackingNo: 'YT1',
      phone: '13800001234',
    });
    expect(urls[0]?.searchParams.get('type')).toBe('YTO');
    expect(urls[0]?.searchParams.get('no')).toBe('YT1');
  });

  it('puts the receiver’s phone tail after a 顺丰 number', async () => {
    const urls = capture();
    await logisticsPort.track(ctx(), {
      companyCode: 'shunfeng',
      trackingNo: 'SF1',
      phone: '13800001234',
    });
    expect(urls[0]?.searchParams.get('type')).toBe('SFEXPRESS');
    expect(urls[0]?.searchParams.get('no')).toBe('SF1:1234');
  });

  it('leaves the carrier to the vendor when our code has no counterpart', async () => {
    const urls = capture();
    await logisticsPort.track(ctx(), { companyCode: 'some-local-courier', trackingNo: 'X1' });
    expect(urls[0]?.searchParams.has('type')).toBe(false);
  });

  it('logs the vendor’s reason when it answers a 200 with no result', async () => {
    capture({ status: '204', msg: '快递公司识别失败' });
    const context = ctx();
    const result = await logisticsPort.track(context, {
      companyCode: 'yuantong',
      trackingNo: 'YT1',
    });
    expect(result).toEqual({ state: 'unknown', traces: [] });
    expect(warnings).toEqual([
      {
        fields: { status: '204', msg: '快递公司识别失败', companyCode: 'yuantong', type: 'YTO' },
        message: '物流查询没有结果',
      },
    ]);
  });
});
