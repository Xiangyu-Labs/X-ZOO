import type { WechatAutoReply } from '@shop/contracts/wechat-oa/schemas';
import { describe, expect, it } from 'vitest';
import { explainSimulation } from './wechat-oa.reply.service';

const rule = (overrides: Partial<WechatAutoReply>): WechatAutoReply => ({
  id: '1',
  triggerKind: 'keyword',
  keyword: '退货',
  matchMode: 'exact',
  replyType: 'text',
  payload: { text: '退货请联系客服' },
  isEnabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('explainSimulation', () => {
  it('names the winning keyword and counts the rules it beat', () => {
    const exact = rule({});
    const contains = rule({ id: '2', keyword: '退', matchMode: 'contains' });
    const result = explainSimulation({
      kind: 'text',
      text: '退货',
      matches: [exact, contains],
      singleton: null,
    });
    expect(result.source).toBe('keyword');
    expect(result.reply?.id).toBe('1');
    expect(result.shadowed.map((reply) => reply.id)).toEqual(['2']);
    expect(result.explanation).toBe(
      '命中关键词「退货」（完全匹配）；另有 1 条规则也匹配，但优先级更低（完全匹配优先，其次排序值小的优先）',
    );
  });

  it('falls back to 默认回复, or says nothing will be sent', () => {
    const fallback = rule({ id: '9', triggerKind: 'default', keyword: null, matchMode: null });
    expect(
      explainSimulation({ kind: 'text', text: '你好', matches: [], singleton: fallback }),
    ).toMatchObject({ source: 'default', explanation: '没有关键词规则匹配，回复「默认回复」' });
    expect(
      explainSimulation({ kind: 'click', text: 'SERVICE', matches: [], singleton: null }),
    ).toMatchObject({
      source: 'none',
      reply: null,
      explanation: '没有关键词规则匹配菜单 key「SERVICE」，也没有启用「默认回复」，公众号不会回复',
    });
  });

  it('answers a follow with the subscribe reply', () => {
    const greeting = rule({ id: '5', triggerKind: 'subscribe', keyword: null, matchMode: null });
    expect(
      explainSimulation({ kind: 'subscribe', text: '', matches: [], singleton: greeting }),
    ).toMatchObject({ source: 'subscribe', reply: { id: '5' } });
    expect(
      explainSimulation({ kind: 'subscribe', text: '', matches: [], singleton: null }).explanation,
    ).toBe('没有启用「关注回复」，新关注的用户收不到消息');
  });
});
