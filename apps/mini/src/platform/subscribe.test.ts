import { afterEach, describe, expect, it } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { onSubscribeResult, setSubscribeTemplates, subscribe } from './subscribe';

describe('subscribe', () => {
  afterEach(() => setSubscribeTemplates({}));

  it('asks for at most three distinct, non-empty templates of the scene', async () => {
    setSubscribeTemplates({ checkout: ['a', 'a', ' ', 'b', 'c', 'd'] });
    const results: unknown[] = [];
    const off = onSubscribeResult((scene, result) => results.push([scene, result]));
    await subscribe('checkout');
    off();
    expect(taroFake.calls[0]).toMatchObject({
      api: 'requestSubscribeMessage',
      args: { tmplIds: ['a', 'b', 'c'] },
    });
    expect(results).toEqual([['checkout', { a: 'accept', b: 'accept', c: 'accept' }]]);
  });

  it('asks nothing when the scene has no templates', async () => {
    setSubscribeTemplates({ refundApply: [] });
    await subscribe('refundApply');
    await subscribe('checkout');
    expect(taroFake.calls).toHaveLength(0);
  });

  it('reports what the shopper chose, a refusal included, without failing the caller', async () => {
    taroFake.subscribeAnswer = 'reject';
    setSubscribeTemplates({ refundApply: ['r'] });
    const results: unknown[] = [];
    const off = onSubscribeResult((_, result) => results.push(result));
    await expect(subscribe('refundApply')).resolves.toBeUndefined();
    off();
    expect(results).toEqual([{ r: 'reject' }]);
  });
});
