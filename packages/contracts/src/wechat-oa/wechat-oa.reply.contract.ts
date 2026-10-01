import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedWechatAutoReplies,
  wechatAutoReply,
  wechatAutoReplyExample,
  wechatAutoReplyForm,
  wechatAutoReplyListQuery,
  wechatReplySimulateBody,
  wechatReplySimulateResult,
  wechatStatusBody,
} from './schemas';

/**
 * Auto-replies, `/admin-api/wechat-auto-replies`.
 *
 * Three triggers share one table and one screen, because they are one decision
 * — "what does the account say back". Three separate screens would mean three
 * half-identical forms and a subscribe reply that could not be previewed next
 * to the keyword ones.
 *
 * `subscribe` and `default` are singletons, enforced by a partial unique index
 * rather than by a read-then-insert; a second one is
 * `WECHAT_OA_REPLY_DUPLICATE`, not a silently overwritten row.
 */

const replyParams = z.object({ id });

export const wechatOaReplyList = defineRoute({
  id: 'wechatOa.replyList',
  method: 'GET',
  path: '/admin-api/wechat-auto-replies',
  auth: 'admin',
  permission: 'wechat-oa:reply:read',
  summary: '自动回复列表',
  tags: ['wechat-oa'],
  query: wechatAutoReplyListQuery,
  response: pagedWechatAutoReplies,
  examples: [
    {
      name: 'keywords',
      query: { page: 1, pageSize: 20, triggerKind: 'keyword' },
      response: { items: [wechatAutoReplyExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'empty',
      query: { page: 1, pageSize: 20 },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const wechatOaReplyDetail = defineRoute({
  id: 'wechatOa.replyDetail',
  method: 'GET',
  path: '/admin-api/wechat-auto-replies/:id',
  auth: 'admin',
  permission: 'wechat-oa:reply:read',
  summary: '自动回复详情',
  tags: ['wechat-oa'],
  params: replyParams,
  response: wechatAutoReply,
  errors: ['WECHAT_OA_REPLY_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: wechatAutoReplyExample }],
});

export const wechatOaReplyCreate = defineRoute({
  id: 'wechatOa.replyCreate',
  method: 'POST',
  path: '/admin-api/wechat-auto-replies',
  auth: 'admin',
  permission: 'wechat-oa:reply:write',
  summary: '新建自动回复',
  tags: ['wechat-oa'],
  body: wechatAutoReplyForm,
  response: wechatAutoReply,
  status: 201,
  errors: ['WECHAT_OA_REPLY_DUPLICATE', 'WECHAT_OA_KEYWORD_TAKEN'],
  examples: [
    {
      name: 'keyword-text',
      body: {
        triggerKind: 'keyword',
        keyword: '优惠券',
        matchMode: 'contains',
        replyType: 'text',
        payload: { text: '点击 https://shop.example.com/coupons 领取本月优惠券' },
        isEnabled: true,
        sortOrder: 0,
      },
      response: wechatAutoReplyExample,
    },
    {
      name: 'subscribe-news',
      body: {
        triggerKind: 'subscribe',
        replyType: 'news',
        payload: {
          articles: [
            {
              title: '欢迎关注',
              description: '新人专享优惠等你领取',
              url: 'https://shop.example.com/welcome',
              picUrl: 'https://shop.example.com/uploads/2026/01/welcome.png',
            },
          ],
        },
        isEnabled: true,
        sortOrder: 0,
      },
      response: {
        ...wechatAutoReplyExample,
        id: '2',
        triggerKind: 'subscribe',
        keyword: null,
        matchMode: null,
        replyType: 'news',
        payload: {
          articles: [
            {
              title: '欢迎关注',
              description: '新人专享优惠等你领取',
              url: 'https://shop.example.com/welcome',
              picUrl: 'https://shop.example.com/uploads/2026/01/welcome.png',
            },
          ],
        },
      },
    },
  ],
});

export const wechatOaReplyUpdate = defineRoute({
  id: 'wechatOa.replyUpdate',
  method: 'PUT',
  path: '/admin-api/wechat-auto-replies/:id',
  auth: 'admin',
  permission: 'wechat-oa:reply:write',
  summary: '编辑自动回复',
  tags: ['wechat-oa'],
  params: replyParams,
  body: wechatAutoReplyForm,
  response: wechatAutoReply,
  errors: ['WECHAT_OA_REPLY_NOT_FOUND', 'WECHAT_OA_KEYWORD_TAKEN'],
  examples: [
    {
      name: 'retext',
      params: { id: '1' },
      body: {
        triggerKind: 'keyword',
        keyword: '优惠券',
        matchMode: 'exact',
        replyType: 'text',
        payload: { text: '回复「领券」获取本月优惠券' },
        isEnabled: true,
        sortOrder: 0,
      },
      response: {
        ...wechatAutoReplyExample,
        matchMode: 'exact',
        payload: { text: '回复「领券」获取本月优惠券' },
      },
    },
  ],
});

export const wechatOaReplySetStatus = defineRoute({
  id: 'wechatOa.replySetStatus',
  method: 'POST',
  path: '/admin-api/wechat-auto-replies/:id/status',
  auth: 'admin',
  permission: 'wechat-oa:reply:write',
  summary: '启用/停用自动回复',
  tags: ['wechat-oa'],
  params: replyParams,
  body: wechatStatusBody,
  response: wechatAutoReply,
  errors: ['WECHAT_OA_REPLY_NOT_FOUND'],
  examples: [
    {
      name: 'disable',
      params: { id: '1' },
      body: { isEnabled: false },
      response: { ...wechatAutoReplyExample, isEnabled: false },
    },
  ],
});

export const wechatOaReplyDelete = defineRoute({
  id: 'wechatOa.replyDelete',
  method: 'DELETE',
  path: '/admin-api/wechat-auto-replies/:id',
  auth: 'admin',
  permission: 'wechat-oa:reply:write',
  summary: '删除自动回复',
  tags: ['wechat-oa'],
  params: replyParams,
  response: z.void(),
  status: 204,
  errors: ['WECHAT_OA_REPLY_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

/**
 * 回复模拟 — which rule answers a message, and which others it beat. Asks the
 * same query the webhook asks, so what it shows is what a follower would get.
 */
export const wechatOaReplySimulate = defineRoute({
  id: 'wechatOa.replySimulate',
  method: 'POST',
  path: '/admin-api/wechat-auto-replies/simulate',
  auth: 'admin',
  permission: 'wechat-oa:reply:read',
  summary: '模拟自动回复',
  tags: ['wechat-oa'],
  body: wechatReplySimulateBody,
  response: wechatReplySimulateResult,
  examples: [
    {
      name: 'keyword',
      body: { kind: 'text', text: '有优惠券吗' },
      response: {
        source: 'keyword',
        reply: wechatAutoReplyExample,
        shadowed: [],
        explanation: '命中关键词「优惠券」（包含匹配）',
      },
    },
    {
      name: 'nothing',
      body: { kind: 'text', text: '你好' },
      response: {
        source: 'none',
        reply: null,
        shadowed: [],
        explanation: '没有关键词规则匹配，也没有启用「默认回复」，公众号不会回复',
      },
    },
  ],
});
